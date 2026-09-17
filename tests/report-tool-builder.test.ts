import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildReportTool } from '../src/report-tool-builder.js';
import { dateRangeInput } from '../src/tool-input.js';
import { counted, makeCtx, ok } from './helpers.js';

const QUERY = { dimensions: ['ADVERTISER_NAME'], metrics: ['REVENUE'] };

function toolFor(reportType?: 'FUTURE_SELL_THROUGH') {
  return buildReportTool({
    name: 'top_advertisers_test',
    description: 'Top advertisers by revenue.',
    input: z.object({ date_range: dateRangeInput('Dates.') }).strict(),
    buildQuery: () => (reportType
      ? { dimensions: ['AD_UNIT_ID'], metrics: ['SELL_THROUGH_FORECASTED_IMPRESSIONS'], report_type: reportType }
      : QUERY),
    summary: (_input, range) => `Test report ${range.start}..${range.end}`,
    warnings: () => ['a caveat'],
  });
}

describe('buildReportTool', () => {
  it('runs through executeReport and returns a typed first page', async () => {
    const ctx = makeCtx({ reports: [{ query: QUERY, rows: [{ ADVERTISER_NAME: 'Acme', REVENUE: 5000 }] }] });
    const r = await toolFor().handler({ date_range: { start: '2026-04-01', end: '2026-04-29' } }, ctx);
    expect(r).toMatchObject({
      summary: 'Test report 2026-04-01..2026-04-29',
      total_row_count: 1,
      warnings: ['a caveat'],
      rows: [{ ADVERTISER_NAME: 'Acme', REVENUE: 5000 }],
      provenance: { date_range: { start: '2026-04-01', end: '2026-04-29' } },
    });
    expect(r).not.toHaveProperty('file_path');
  });

  it('resolves a relative range in the date time zone and summarises the resolved dates', async () => {
    const ctx = makeCtx({ reports: [{ query: QUERY, rows: [] }] });
    const r = ok(await toolFor().handler({ date_range: { relative: 'last_7_days' } }, ctx));
    expect(r.summary).toBe('Test report 2026-09-10..2026-09-16');
    expect(r.provenance.date_range).toEqual({ start: '2026-09-10', end: '2026-09-16' });
  });

  it('F4: refuses a date GAM should never see, before creating anything', async () => {
    const { ctx, counters } = counted({ reports: [{ query: QUERY, rows: [] }] });
    for (const date_range of [
      { start: 'banana', end: '2026-09-01' },
      { start: '2026-09-01', end: '2026-09-17' },
      { start: '2026-09-30', end: '2026-10-01' },
    ]) {
      expect(await toolFor().handler({ date_range }, ctx)).toMatchObject({ error: { code: 'INVALID_DATE_RANGE' } });
    }
    expect(counters.report_definitions_created).toBe(0);
  });

  it('checks a forecast query by the forecast rule', async () => {
    const query = { dimensions: ['AD_UNIT_ID'], metrics: ['SELL_THROUGH_FORECASTED_IMPRESSIONS'] };
    const ctx = makeCtx({ reports: [{ query, rows: [] }] });
    const tool = toolFor('FUTURE_SELL_THROUGH');
    expect(await tool.handler({ date_range: { start: '2026-09-16', end: '2026-09-30' } }, ctx))
      .toMatchObject({ error: { code: 'INVALID_DATE_RANGE' } });
    expect(ok(await tool.handler({ date_range: { start: '2026-09-17', end: '2026-09-30' } }, ctx)).summary)
      .toBe('Test report 2026-09-17..2026-09-30');
  });
});
