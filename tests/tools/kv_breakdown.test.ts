import { describe, it, expect } from 'vitest';
import { kvBreakdownTool } from '../../src/tools/kv_breakdown.js';
import { makeCtx, NETWORK } from '../helpers.js';
import type { GAMClient, ReportQuery, DateRange } from '../../src/gam-client.js';

// A full GAMClient spy over the new report path (defineReport → runReport →
// pollOperation → fetchRows), used where the fixture matcher in the mock
// client isn't precise enough — this captures the exact query/dateRange the
// tool hands to GAM.
function spyClient(onDefine: (query: ReportQuery, dateRange: DateRange) => void): GAMClient {
  return {
    async listEntities() { return []; },
    async getResource() { return null; },
    async defineReport(query, dateRange) {
      onDefine(query, dateRange);
      return { report: `networks/${NETWORK}/reports/1` };
    },
    async runReport() { return { operation: `networks/${NETWORK}/operations/reports/runs/1` }; },
    async pollOperation() {
      const result = `networks/${NETWORK}/reports/1/results/1`;
      return { state: 'done', result };
    },
    async fetchRows() {
      return {
        rows: [{ dimensionValues: [{ stringValue: 'sports' }], metricValueGroups: [{ primaryValues: [{ intValue: '1000' }] }] }],
        totalRowCount: 1,
        runTime: '2026-01-01T00:00:00Z',
        dateRanges: [{ start: '2026-05-01', end: '2026-05-07' }],
      };
    },
    async getReport() { return null; },
  };
}

describe('kv_breakdown', () => {
  it('queries CUSTOM_DIMENSION_0_VALUE with the chosen metric', async () => {
    const args = kvBreakdownTool.input.parse({
      custom_targeting_key_id: 999,
      date_range: { start: '2026-04-01', end: '2026-04-29' },
      metric: 'revenue',
      top_n: 10,
    });
    const r = await kvBreakdownTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: { dimensions: ['CUSTOM_DIMENSION_0_VALUE'], metrics: ['REVENUE'] },
          rows: [
            { CUSTOM_DIMENSION_0_VALUE: 'sports', REVENUE: 1234 },
            { CUSTOM_DIMENSION_0_VALUE: 'news', REVENUE: 5678 },
          ],
        }] },
        { timezone: 'America/Los_Angeles' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(2);
  });

  // Stronger check: the mock client's fixture matcher ignores filters and
  // custom_dimension_key_ids, but those are the load-bearing parts of this
  // tool — a regression that drops the key-id wire-up would still pass the
  // basic mock test above. Capture the raw query/dateRange that hits the
  // client and assert their exact shape.
  it('wires custom_dimension_key_ids[0] = key and applies entity filters', async () => {
    let captured: { query: ReportQuery; dateRange: DateRange } | null = null;
    const client = spyClient((query, dateRange) => { captured = { query, dateRange }; });

    const args = kvBreakdownTool.input.parse({
      custom_targeting_key_id: 4242,
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metric: 'impressions',
      ad_unit_id: 77,
      order_id: 88,
    });
    const r = await kvBreakdownTool.handler(args, makeCtx({}, { client, timezone: 'America/Los_Angeles' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(captured).not.toBeNull();
    expect(captured!.query.dimensions).toEqual(['CUSTOM_DIMENSION_0_VALUE']);
    expect(captured!.query.metrics).toEqual(['IMPRESSIONS']);
    expect(captured!.query.custom_dimension_key_ids).toEqual([4242]);
    expect(captured!.query.filters).toEqual([
      { field: 'AD_UNIT_ID', op: '=', value: 77 },
      { field: 'ORDER_ID', op: '=', value: 88 },
    ]);
    expect(captured!.dateRange).toEqual({ start: '2026-05-01', end: '2026-05-07' });
  });

  it('omits filters when no entity narrowing is given', async () => {
    let captured: ReportQuery | null = null;
    const client = spyClient((query) => { captured = query; });

    const args = kvBreakdownTool.input.parse({
      custom_targeting_key_id: 1,
      date_range: { start: '2026-05-01', end: '2026-05-07' },
    });
    const r = await kvBreakdownTool.handler(args, makeCtx({}, { client, timezone: 'America/Los_Angeles' }));
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(captured!.filters).toBeUndefined();
  });
});
