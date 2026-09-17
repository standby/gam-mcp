import { describe, it, expect } from 'vitest';
import { runReportTool } from '../src/tools/run_report.js';
import { kvReportTool } from '../src/tools/kv_report.js';
import { comparePeriodsTool } from '../src/tools/compare_periods.js';
import { runSavedQueryTool } from '../src/tools/saved_queries.js';
import type { ToolDefinition } from '../src/report-tool-builder.js';
import { makeCtx, ok } from './helpers.js';

// makeCtx: Asia/Tokyo, 2026-09-17 12:00 local. Yesterday is 2026-09-16.
const TODAY = '2026-09-17';

// Tools that take a range, the field it arrives in, and valid arguments
// without it. Task 2 adds the report-builder tools.
const CASES: { tool: ToolDefinition<any>; field: string; rest: Record<string, unknown> }[] = [
  { tool: runReportTool, field: 'date_range', rest: { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] } },
  { tool: kvReportTool, field: 'date_range', rest: { kv: 'section=news', metrics: ['IMPRESSIONS'] } },
  {
    tool: comparePeriodsTool,
    field: 'base_range',
    rest: { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'], comparison: 'previous_period' },
  },
];

async function call(tool: ToolDefinition<any>, args: Record<string, unknown>, over = {}) {
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) return { parseError: parsed.error };
  return tool.handler(parsed.data, makeCtx({}, over));
}

function dateError(r: unknown): { field: string; reason: string } {
  const e = (r as { error?: { code: string; details: { field: string; reason: string } } }).error;
  expect(e?.code, JSON.stringify(r)).toBe('INVALID_DATE_RANGE');
  return e!.details;
}

describe('every range-taking tool checks its dates (spec §3.2, I5)', () => {
  describe.each(CASES)('$tool.name', ({ tool, field, rest }) => {
    it.each([
      ['banana', { start: 'banana', end: '2026-09-02' }],
      ['an impossible date', { start: '2026-02-30', end: '2026-03-02' }],
      ['an end of today', { start: '2026-09-01', end: TODAY }],
      ['start after end', { start: '2026-09-05', end: '2026-09-01' }],
    ])('rejects %s', async (_label, range) => {
      expect(dateError(await call(tool, { ...rest, [field]: range })).field).toBe(field);
    });

    it('rejects month_to_date on the first of the month', async () => {
      const r = await call(tool, { ...rest, [field]: { relative: 'month_to_date' } }, { now: new Date('2026-09-01T04:00:00Z') });
      expect(dateError(r).reason).toContain('no complete day in this period yet');
    });

    it('does not accept relative today', async () => {
      expect(await call(tool, { ...rest, [field]: { relative: 'today' } })).toHaveProperty('parseError');
    });
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

  it('run_saved_query applies the same rules', async () => {
    const savedQueries = {
      get: () => ({ name: 'q', saved_at: 'x', body: { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] } }),
    };
    const parsed = runSavedQueryTool.input.parse({ name: 'q', date_range: { start: '2026-09-01', end: TODAY } });
    const r = await runSavedQueryTool.handler(parsed, makeCtx({}, { savedQueries: savedQueries as never }));
    expect(dateError(r).field).toBe('date_range');
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
