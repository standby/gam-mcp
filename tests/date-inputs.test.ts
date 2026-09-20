import { describe, it, expect } from 'vitest';
import { ALL_TOOLS } from '../src/tools/index.js';
import { runReportTool } from '../src/tools/run_report.js';
import { comparePeriodsTool } from '../src/tools/compare_periods.js';
import { toJsonSchema, type JsonSchema } from '../src/json-schema.js';
import type { ToolDefinition } from '../src/report-tool-builder.js';
import { makeCtx, ok } from './helpers.js';
import { argsFor, toolWorld } from './tool-table.js';

// makeCtx: Asia/Tokyo, 2026-09-17 13:00 local. Yesterday is 2026-09-16.
const TODAY = '2026-09-17';
const FORECAST_TOOLS = new Set(['sell_through']);

// A top-level field advertised as { start, end } | { relative }.
function isRange(p: JsonSchema): boolean {
  const first = (p.anyOf as JsonSchema[] | undefined)?.[0];
  return (first?.properties as Record<string, JsonSchema> | undefined)?.start?.format === 'date';
}

// Every tool field that takes a range, found from the advertised schemas, so
// a new range-taking tool is covered without being listed here.
const CASES = ALL_TOOLS.flatMap((tool) =>
  Object.entries((toJsonSchema(tool.input).properties ?? {}) as Record<string, JsonSchema>)
    .filter(([, p]) => isRange(p))
    .map(([field]) => ({ name: tool.name, tool, field })),
);

async function call(tool: ToolDefinition<any>, args: Record<string, unknown>, over = {}) {
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) return { parseError: parsed.error };
  return tool.handler(parsed.data, toolWorld(over));
}

function dateError(r: unknown): { field: string; reason: string } {
  const e = (r as { error?: { code: string; details: { field: string; reason: string } } }).error;
  expect(e?.code, JSON.stringify(r)).toBe('INVALID_DATE_RANGE');
  return e!.details;
}

describe('every range-taking tool checks its dates (spec §3.2, I5)', () => {
  it('finds the range fields', () => {
    expect(CASES.map((c) => `${c.name}.${c.field}`)).toEqual(expect.arrayContaining([
      'run_report.date_range', 'revenue_summary.date_range', 'fill_rate.date_range',
      'compare_periods.base_range', 'sell_through.date_range', 'run_saved_query.date_range',
      'pacing_status.date_range',
    ]));
    expect(CASES.length).toBe(20);
  });

  describe.each(CASES)('$name', ({ name, tool, field }) => {
    const forecast = FORECAST_TOOLS.has(name);
    const rest = argsFor(name);

    it.each([
      ['banana', { start: 'banana', end: '2026-09-30' }],
      ['an impossible date', { start: '2026-02-30', end: '2026-03-02' }],
      ['start after end', { start: '2026-09-25', end: '2026-09-21' }],
      [forecast ? 'a start of yesterday' : 'an end of today', forecast ? { start: '2026-09-16', end: '2026-09-30' } : { start: '2026-09-01', end: TODAY }],
    ])('rejects %s', async (_label, range) => {
      expect(dateError(await call(tool, { ...rest, [field]: range })).field).toBe(field);
    });

    it('does not accept relative today', async () => {
      expect(await call(tool, { ...rest, [field]: { relative: 'today' } })).toHaveProperty('parseError');
    });

    if (forecast) {
      it('refuses a relative range and accepts a window from today', async () => {
        expect(dateError(await call(tool, { ...rest, [field]: { relative: 'yesterday' } })).reason).toContain('not a relative range');
        expect(await call(tool, { ...rest, [field]: { start: TODAY, end: TODAY } })).not.toHaveProperty('error');
      });
    } else {
      it('rejects month_to_date on the first of the month and accepts yesterday', async () => {
        const first = await call(tool, { ...rest, [field]: { relative: 'month_to_date' } }, { now: new Date('2026-09-01T04:00:00Z') });
        expect(dateError(first).reason).toContain('no complete day in this period yet');
        expect(await call(tool, { ...rest, [field]: { relative: 'yesterday' } })).not.toHaveProperty('error');
      });
    }
  });
});

describe('run_report picks the date rule from the report type', () => {
  const sellThrough = { dimensions: ['AD_UNIT_ID'], metrics: ['SELL_THROUGH_FORECASTED_IMPRESSIONS'] };

  it('a sell-through query must start today or later', async () => {
    const r = await call(runReportTool, { ...sellThrough, date_range: { start: '2026-09-16', end: '2026-09-30' } });
    expect(dateError(r).reason).toContain('before today (2026-09-17)');
  });

  it('a sell-through query cannot use a relative range', async () => {
    const r = await call(runReportTool, { ...sellThrough, date_range: { relative: 'yesterday' } });
    expect(dateError(r).reason).toContain('not a relative range');
  });
});

describe('compare_periods comparison ranges', () => {
  const query = { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] };

  it('checks an explicit comparison range as a historical range', async () => {
    const r = await call(comparePeriodsTool, {
      ...query,
      base_range: { start: '2026-09-01', end: '2026-09-07' },
      comparison: { start: '2026-09-10', end: TODAY },
    });
    expect(dateError(r).field).toBe('comparison');
  });

  it('I4: previous_year for February 2028 compares with all of February 2027', async () => {
    const ctx = makeCtx({
      reports: [
        { query, dateRange: { start: '2028-02-01', end: '2028-02-29' }, rows: [{ AD_UNIT_ID: 1, IMPRESSIONS: 20 }] },
        { query, dateRange: { start: '2027-02-01', end: '2027-02-28' }, rows: [{ AD_UNIT_ID: 1, IMPRESSIONS: 10 }] },
      ],
    }, { now: new Date('2028-03-10T04:00:00Z') });
    const args = comparePeriodsTool.input.parse({
      ...query,
      base_range: { start: '2028-02-01', end: '2028-02-29' },
      comparison: 'previous_year',
    });
    const r = ok(await comparePeriodsTool.handler(args, ctx));
    expect(r.summary).toContain('prev=2027-02-01..2027-02-28');
  });
});
