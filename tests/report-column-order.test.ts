import { describe, it, expect } from 'vitest';
import { executeReport, executeReportRows } from '../src/report-exec.js';
import { createReportCache } from '../src/cache.js';
import type { ReportQuery } from '../src/gam-client.js';
import type { ToolContext } from '../src/report-tool-builder.js';
import { createFakeGam, int } from './fake-gam.js';
import { counted, ok, restCtx } from './helpers.js';

// GAM returns each row's values in the column order of the report that ran,
// so the order of dimensions and metrics is part of what a report is: two
// requests that list the same fields in different orders must not share a
// report, a run or a cached result, or one of them reads its values under
// the other's column names (spec §2.2).
const RANGE = { start: '2026-09-01', end: '2026-09-02' };
const A: ReportQuery = { dimensions: ['AD_UNIT_ID', 'DATE'], metrics: ['IMPRESSIONS', 'AD_REQUESTS'] };
const B: ReportQuery = { dimensions: ['DATE', 'AD_UNIT_ID'], metrics: ['AD_REQUESTS', 'IMPRESSIONS'] };
// Every column holds a value no other column could be mistaken for.
const ROW = { AD_UNIT_ID: 7, DATE: '2026-09-01', IMPRESSIONS: 100, AD_REQUESTS: 200 };

const columnsOf = (q: ReportQuery) => [...q.dimensions, ...q.metrics];

// The single row, as a result for `q` must show it: right values, in q's column order.
function expectRow(rows: Record<string, unknown>[], q: ReportQuery): void {
  expect(rows).toEqual([ROW]);
  expect(Object.keys(rows[0])).toEqual(columnsOf(q));
}

const caches = [
  ['with a result cache', () => createReportCache()],
  ['without a result cache', () => undefined],
] as const;

type Call = (q: ReportQuery) => Promise<Record<string, unknown>[]>;
const sequences = [
  ['one after the other', async (call: Call) => [await call(A), await call(B)]],
  ['concurrently', (call: Call) => Promise.all([call(A), call(B)])],
] as const;

function mockCtx(cache: (typeof caches)[number][1]) {
  const reportCache = cache();
  return counted({ reports: [{ query: A, rows: [ROW] }] }, reportCache ? { reportCache } : {});
}

describe('dimension and metric order is part of a report (spec §2.2)', () => {
  describe.each(caches)('%s', (_, cache) => {
    it.each(sequences)('executeReport: the same fields in two orders, %s, run two reports and label each row right', async (__, sequence) => {
      const { ctx, counters } = mockCtx(cache);
      const [a, b] = await sequence(async (query) => {
        const page = ok(await executeReport(ctx, { tool: 'test', query, dateRange: RANGE, summary: 'S' }));
        expect(page.schema.map((c) => c.name)).toEqual(columnsOf(query));
        expect(page.provenance).toMatchObject({ dimensions: query.dimensions, metrics: query.metrics });
        return page.rows;
      });
      expectRow(a, A);
      expectRow(b, B);
      expect(counters).toMatchObject({ report_definitions_created: 2, report_jobs_created: 2 });
    });

    it.each(sequences)('executeReportRows: the same fields in two orders, %s, run two reports and label each row right', async (__, sequence) => {
      const { ctx, counters } = mockCtx(cache);
      const [a, b] = await sequence(async (query) => {
        const table = await executeReportRows(ctx, query, RANGE, 'test');
        if ('error' in table) throw new Error(JSON.stringify(table));
        expect(table.columns.map((c) => c.name)).toEqual(columnsOf(query));
        return table.rows;
      });
      expectRow(a, A);
      expectRow(b, B);
      expect(counters).toMatchObject({ report_definitions_created: 2, report_jobs_created: 2 });
    });
  });

  it('REST: a second process asking for the same fields in another order does not run the first order\'s report', async () => {
    // The fake encodes rows in the stored report's order, as GAM does.
    const gam = createFakeGam();
    gam.setRows({ byColumn: [{ AD_UNIT_ID: int(7), DATE: int(20260901), IMPRESSIONS: int(100), AD_REQUESTS: int(200) }] });
    const run = async (ctx: ToolContext, query: ReportQuery) =>
      ok(await executeReport(ctx, { tool: 'test', query, dateRange: RANGE, summary: 'S' }));
    const first = await run(restCtx(gam), A);
    const second = await run(restCtx(gam, { reportCache: createReportCache() }), B);
    expectRow(first.rows, A);
    expectRow(second.rows, B);
    expect(second.provenance.report).not.toBe(first.provenance.report);
    expect(gam.reports.size).toBe(2);
    expect(gam.requests.filter((r) => r.method === 'POST' && r.path.endsWith(':run'))).toHaveLength(2);
  });
});
