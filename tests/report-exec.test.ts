import { describe, it, expect } from 'vitest';
import {
  derivedEnvelope, executeReport, executeReportRows, fetchReportPage, pollUntilDone, resolvePageRows,
  REMEMBERED_RESULTS_MAX,
} from '../src/report-exec.js';
import { decodeCursor, encodeCursor, type Cursor } from '../src/cursor.js';
import { REACH_COVERAGE_WARNING, REACH_NON_ADDITIVE_WARNING } from '../src/report-warnings.js';
import { createLogger } from '../src/log.js';
import { definitionFor, makeCtx, NETWORK } from './helpers.js';
import type { Provenance, ResultEnvelope } from '../src/envelope.js';
import type { ReportDefinition } from '../src/report-definition.js';

const RANGE = { start: '2026-09-01', end: '2026-09-02' };
const query = { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] };
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ AD_UNIT_ID: i + 1, IMPRESSIONS: (i + 1) * 10 }));
const LATER_PAGE_NOTICE =
  "Some caveats, such as renamed dimensions or rewritten key-value filters, are listed only on this report's first page; read them with these rows.";

function ok(r: unknown): ResultEnvelope {
  if (r && typeof r === 'object' && 'error' in r) throw new Error(JSON.stringify(r));
  return r as ResultEnvelope;
}

describe('executeReport', () => {
  it('A1: provenance carries the dates GAM computed, its run time and both counts', async () => {
    const ctx = makeCtx({ reports: [{
      query, rows: rows(2), runTime: '2026-09-03T01:00:00Z',
      computedDateRange: { start: '2026-08-31', end: '2026-09-02' },
    }] });
    const r = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    expect(r.provenance).toEqual({
      network_code: NETWORK, report_type: 'HISTORICAL',
      report: `networks/${NETWORK}/reports/1`, result: `networks/${NETWORK}/reports/1/results/1`,
      run_time: '2026-09-03T01:00:00Z', date_range: { start: '2026-08-31', end: '2026-09-02' },
      date_time_zone: 'Asia/Tokyo', dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'],
      filters: [], sort: [], cache: { hit: false },
    });
    expect(r).toMatchObject({ summary: 'S', total_row_count: 2, returned_row_count: 2, truncated: false, next_cursor: null });
    expect(r.rows).toEqual([{ AD_UNIT_ID: 1, IMPRESSIONS: 10 }, { AD_UNIT_ID: 2, IMPRESSIONS: 20 }]);
    expect(r.schema).toEqual([{ name: 'AD_UNIT_ID', type: 'integer' }, { name: 'IMPRESSIONS', type: 'integer' }]);
  });

  it('A1: provenance copies filters in GAM form', async () => {
    const q = { ...query, filters: [{ field: 'AD_UNIT_ID', op: '=' as const, value: 1 }] };
    const ctx = makeCtx({ reports: [{ query: q, rows: rows(1) }] });
    const r = ok(await executeReport(ctx, { query: q, dateRange: RANGE, summary: 'S' }));
    expect((r.provenance as { filters: unknown[] }).filters).toEqual([
      { fieldFilter: { field: { dimension: 'AD_UNIT_ID' }, operation: 'IN', values: [{ intValue: '1' }] } },
    ]);
  });

  it('A2: pages through the whole result with no gap or overlap', async () => {
    const all = rows(12_000);
    const ctx = makeCtx({ reports: [{ query, rows: all }] }, { pageRows: 5_000 });
    const first = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    expect(first).toMatchObject({ total_row_count: 12_000, returned_row_count: 5_000, truncated: true });
    const second = ok(await fetchReportPage(ctx, first.next_cursor!));
    expect(second).toMatchObject({ total_row_count: 12_000, returned_row_count: 5_000, truncated: true });
    expect(second.provenance).toMatchObject({ date_range: RANGE, run_time: '2026-01-01T00:00:00Z', dimensions: ['AD_UNIT_ID'] });
    const third = ok(await fetchReportPage(ctx, second.next_cursor!));
    expect(third).toMatchObject({ returned_row_count: 2_000, truncated: false, next_cursor: null });
    expect([...first.rows, ...second.rows, ...third.rows]).toEqual(all);
    expect(third.summary).toBe(`Rows 10001–12000 of 12000 from networks/${NETWORK}/reports/1`);
  });

  it('A3: never asks GAM for more than 10,000 rows a page', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(10_500) }] }, { pageRows: 20_000 });
    const pageSizes: number[] = [];
    const realFetch = ctx.client.fetchRows;
    ctx.client = { ...ctx.client, fetchRows: async (r, p) => { pageSizes.push(p.pageSize); return realFetch(r, p); } };
    const r = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    expect(r.returned_row_count).toBe(10_000);
    // The mock and fake-gam both clamp pageSize themselves, so this is the
    // assertion that actually exercises report-exec's own clamp: it records
    // what pageRows() asked for, not what the fixture served.
    expect(pageSizes).toEqual([10_000]);
  });

  it('A3: resolvePageRows validates and clamps GAM_PAGE_ROWS, logging the clamp', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', sink: (s: string) => { lines.push(s); } });
    expect(resolvePageRows(undefined, logger)).toBe(5_000);
    expect(resolvePageRows('200', logger)).toBe(200);
    expect(resolvePageRows('20000', logger)).toBe(10_000);
    expect(lines.filter((l) => l.includes('config.page_rows_clamped'))).toHaveLength(1);
    expect(resolvePageRows('0', logger)).toHaveProperty('error');
    expect(resolvePageRows('ten', logger)).toHaveProperty('error');
  });

  it('later pages carry a reminder that caveats live on the first page, not the caveats themselves', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3) }] }, { pageRows: 2 });
    const first = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S', warnings: ['caveat'] }));
    expect(first.warnings).toEqual(['caveat']);
    const second = ok(await fetchReportPage(ctx, first.next_cursor!));
    expect(second.warnings).toContain(LATER_PAGE_NOTICE);
  });

  it('A6: later pages are labelled from the stored definition, not from memory', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3) }] }, { pageRows: 2 });
    const first = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    // A fresh context over the same client simulates a restarted tool layer.
    const again = ok(await fetchReportPage({ ...ctx }, first.next_cursor!));
    expect(again.schema.map((c) => c.name)).toEqual(['AD_UNIT_ID', 'IMPRESSIONS']);
    expect(again.rows).toEqual([{ AD_UNIT_ID: 3, IMPRESSIONS: 30 }]);
  });

  it('A8: rejects a cursor for another network and a malformed cursor', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3) }] }, { pageRows: 2 });
    const first = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    const other = makeCtx({}, { networkCode: '9999' });
    expect(await fetchReportPage(other, first.next_cursor!)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await fetchReportPage(ctx, 'not a cursor!')).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('A8: a page token GAM rejects surfaces as an error', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3) }] }, { pageRows: 2 });
    const first = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    const cursor = decodeCursor(first.next_cursor!, NETWORK);
    if ('error' in cursor) throw new Error(cursor.error);
    const bad = Buffer.from(JSON.stringify({ ...cursor, page_token: 'garbage' })).toString('base64url');
    const r = await fetchReportPage(ctx, bad);
    expect(r).toHaveProperty('error');
  });

  it('A9: an expired result is REPORT_RESULT_EXPIRED, on the first page and on a later one', async () => {
    const result = `networks/${NETWORK}/reports/1/results/1`;
    const fresh = makeCtx({ reports: [{ query, rows: rows(3) }] }, { pageRows: 2 });
    const first = ok(await executeReport(fresh, { query, dateRange: RANGE, summary: 'S' }));
    // A second mock whose report 1 / run 1 result is already gone.
    const expiring = makeCtx({ reports: [{ query, rows: rows(3) }], expiredResults: [result] }, { pageRows: 2 });
    expect(await executeReport(expiring, { query, dateRange: RANGE, summary: 'S' })).toMatchObject({
      error: { code: 'REPORT_RESULT_EXPIRED', details: { result } },
    });
    expect(await fetchReportPage(expiring, first.next_cursor!)).toMatchObject({
      error: { code: 'REPORT_RESULT_EXPIRED', details: { result } },
    });
  });

  it('warns when GAM reports no row count and more pages exist', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3) }] }, { pageRows: 2 });
    const realFetch = ctx.client.fetchRows;
    ctx.client = { ...ctx.client, fetchRows: async (r, p) => { const page = await realFetch(r, p); delete page.totalRowCount; return page; } };
    const r = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    expect(r.total_row_count).toBeNull();
    expect(r.warnings).toContain('GAM did not report how many rows this result has.');
    expect(r.truncated).toBe(true);
  });

  it('a final page with no reported count still knows its total', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3) }] }, { pageRows: 2 });
    const realFetch = ctx.client.fetchRows;
    ctx.client = { ...ctx.client, fetchRows: async (r, p) => { const page = await realFetch(r, p); delete page.totalRowCount; return page; } };
    const first = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    expect(first.total_row_count).toBeNull();
    const second = ok(await fetchReportPage(ctx, first.next_cursor!));
    expect(second).toMatchObject({ total_row_count: 3, truncated: false, next_cursor: null });
    expect(second.warnings).not.toContain('GAM did not report how many rows this result has.');
  });

  it('returns REPORT_FAILED when the run fails', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(1) }], runOutcomes: { 1: 'failed' } });
    expect(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }))
      .toMatchObject({ error: { code: 'REPORT_FAILED' } });
  });
});

describe('pollUntilDone', () => {
  it('F7: waits 2s, then ×1.5 each poll, capped at 15s', async () => {
    const delays: number[] = [];
    // The injected sleep does not advance Date.now, so the test stops the loop itself.
    const ctx = makeCtx({ reports: [{ query, rows: rows(1) }], runOutcomes: { 1: 'never' } }, {
      reportTimeoutMs: 60_000,
      sleep: async (ms) => { delays.push(ms); if (delays.length === 8) throw new Error('stop'); },
    });
    const { report } = await ctx.client.defineReport(definitionFor(query, RANGE));
    const { operation } = await ctx.client.runReport(report);
    await expect(pollUntilDone(ctx, operation)).rejects.toThrow('stop');
    expect(delays).toEqual([2000, 3000, 4500, 6750, 10125, 15000, 15000, 15000]);
  });

  it('times out with REPORT_TIMEOUT naming the operation', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(1) }], runOutcomes: { 1: 'never' } }, { reportTimeoutMs: 0 });
    const { report } = await ctx.client.defineReport(definitionFor(query, RANGE));
    const { operation } = await ctx.client.runReport(report);
    expect(await pollUntilDone(ctx, operation)).toMatchObject({
      error: { code: 'REPORT_TIMEOUT', details: { operation } },
    });
  });
});

describe('executeReportRows and derivedEnvelope', () => {
  it('reads every page and names the input report', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(25_000) }] });
    const r = await executeReportRows(ctx, query, RANGE);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.rows).toHaveLength(25_000);
    expect(r.input).toEqual({
      report: `networks/${NETWORK}/reports/1`, result: `networks/${NETWORK}/reports/1/results/1`,
      run_time: '2026-01-01T00:00:00Z', date_range: RANGE,
    });
  });

  it('A4: refuses an input report over 50,000 rows', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(50_001) }] });
    expect(await executeReportRows(ctx, query, RANGE)).toMatchObject({
      error: { code: 'RESULT_TOO_LARGE', details: { rows: 50_001, limit: 50_000 } },
    });
  });

  it('warns when the loop ends short of the reported total row count', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3) }] });
    const realFetch = ctx.client.fetchRows;
    ctx.client = {
      ...ctx.client,
      fetchRows: async (r, p) => {
        const page = await realFetch(r, p);
        return { ...page, totalRowCount: 5 };
      },
    };
    const r = await executeReportRows(ctx, query, RANGE);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.rows).toHaveLength(3);
    expect(r.warnings).toContain(
      `GAM reported 5 rows for ${r.input.result} but served 3; results below were computed from 3 rows.`,
    );
  });

  it('A4: refuses computed output over the page size instead of cutting it', () => {
    const ctx = makeCtx({}, { pageRows: 2 });
    const input = { report: 'r', result: 'r/results/1', run_time: null, date_range: null };
    expect(derivedEnvelope(ctx, { summary: 'S', inputs: [input], rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }))
      .toMatchObject({ error: { code: 'RESULT_TOO_LARGE', details: { rows: 3, limit: 2 } } });
    const e = derivedEnvelope(ctx, { summary: 'S', inputs: [input], rows: [{ a: 1 }] });
    expect(e).toMatchObject({
      provenance: { network_code: NETWORK, date_time_zone: 'Asia/Tokyo', inputs: [input] },
      total_row_count: 1, truncated: false, next_cursor: null,
    });
  });
});

describe('one definition per call', () => {
  it('hands the client the definition that provenance describes, once per call', async () => {
    const q = { ...query, filters: [{ field: 'AD_UNIT_ID', op: 'IN' as const, value: [2, 1] }] };
    const ctx = makeCtx({ reports: [{ query: q, rows: rows(1) }] });
    const seen: ReportDefinition[] = [];
    const inner = ctx.client;
    ctx.client = {
      ...inner,
      defineReport: (definition) => { seen.push(definition); return inner.defineReport(definition); },
    };
    const r = ok(await executeReport(ctx, { query: q, dateRange: RANGE, summary: 'S' }));
    expect(seen).toEqual([definitionFor(q, RANGE)]);
    const p = r.provenance as Provenance;
    expect(p.report_type).toBe(seen[0].reportType);
    expect(p.dimensions).toEqual(seen[0].dimensions);
    expect(p.filters).toEqual(seen[0].filters);
    const other = { start: '2026-09-03', end: '2026-09-03' };
    await executeReportRows(ctx, q, other);
    expect(seen).toEqual([definitionFor(q, RANGE), definitionFor(q, other)]);
  });

  it('reports the sort and cache state of the definition GAM stored', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3) }] }, { pageRows: 2 });
    const sorts = [{ field: { metric: 'IMPRESSIONS' }, descending: true }];
    const { report } = await ctx.client.defineReport({ ...definitionFor(query, RANGE), sorts });
    const { operation } = await ctx.client.runReport(report);
    const done = await pollUntilDone(ctx, operation);
    if ('error' in done) throw new Error(JSON.stringify(done));
    const cursor = encodeCursor({
      result: done.result, page_token: '2', offset: 2, total_row_count: 3, run_time: null, date_range: null,
    });
    expect(ok(await fetchReportPage(ctx, cursor)).provenance).toMatchObject({ sort: sorts, cache: { hit: false } });
  });
});

describe('later pages take their facts from the server (PR 1 review)', () => {
  const facts = { runTime: '2026-09-03T01:00:00Z', computedDateRange: { start: '2026-08-31', end: '2026-09-02' } };

  it('reports GAM run time, dates and total even when the cursor claims others', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3), ...facts }] }, { pageRows: 2 });
    const first = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    const cursor = decodeCursor(first.next_cursor!, NETWORK) as Cursor;
    const forged = encodeCursor({
      ...cursor,
      run_time: '1999-01-01T00:00:00Z',
      date_range: { start: '1999-01-01', end: '1999-01-02' },
      total_row_count: 999,
    });
    const page = ok(await fetchReportPage(ctx, forged));
    expect(page.provenance).toMatchObject({ run_time: facts.runTime, date_range: facts.computedDateRange });
    expect(page.total_row_count).toBe(3);
    expect(page.summary).toBe(`Rows 3–3 of 3 from networks/${NETWORK}/reports/1`);
  });

  it('reads the facts again from GAM, one row, when this process has none', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3), ...facts }] }, { pageRows: 2 });
    const first = ok(await executeReport(ctx, { query, dateRange: RANGE, summary: 'S' }));
    const cursor = decodeCursor(first.next_cursor!, NETWORK) as Cursor;
    const blank = encodeCursor({ ...cursor, run_time: null, date_range: null, total_row_count: null });
    // A new client object stands for a restarted process: it remembers nothing.
    const inner = ctx.client;
    const sizes: number[] = [];
    const restarted = {
      ...ctx,
      client: { ...inner, fetchRows: (r: string, p: { pageSize: number; pageToken?: string }) => { sizes.push(p.pageSize); return inner.fetchRows(r, p); } },
    };
    const page = ok(await fetchReportPage(restarted, blank));
    expect(sizes).toEqual([1, 2]);
    expect(page.provenance).toMatchObject({ run_time: facts.runTime, date_range: facts.computedDateRange });
    expect(page.total_row_count).toBe(3);
    expect(page.warnings).not.toContain('GAM did not report the computed date range for this result.');
  });

  it('carries the caveats a stored definition implies, and the pointer to the rest', async () => {
    const reach = { dimensions: ['LINE_ITEM_ID'], metrics: ['UNIQUE_VISITORS'], report_type: 'REACH' as const };
    const reachRows = [1, 2, 3].map((n) => ({ LINE_ITEM_ID: n, UNIQUE_VISITORS: n }));
    const ctx = makeCtx({ reports: [{ query: reach, rows: reachRows }] }, { pageRows: 2 });
    const first = ok(await executeReport(ctx, {
      query: reach, dateRange: RANGE, summary: 'S', warnings: [REACH_NON_ADDITIVE_WARNING, 'renamed a dimension'],
    }));
    expect(first.warnings).toEqual([REACH_NON_ADDITIVE_WARNING, 'renamed a dimension', REACH_COVERAGE_WARNING]);
    const second = ok(await fetchReportPage(ctx, first.next_cursor!));
    expect(second.warnings).toEqual([LATER_PAGE_NOTICE, REACH_NON_ADDITIVE_WARNING, REACH_COVERAGE_WARNING]);
  });

  it('remembers stored definitions and facts for a bounded number of results', () => {
    expect(REMEMBERED_RESULTS_MAX).toBe(1000);
  });
});
