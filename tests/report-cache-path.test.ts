import { describe, it, expect } from 'vitest';
import { executeReport, executeReportRows } from '../src/report-exec.js';
import { createReportCache, type ReportCache } from '../src/cache.js';
import { definitionHash, reportName } from '../src/report-key.js';
import { reachReportTool } from '../src/tools/reach_report.js';
import { REACH_NON_ADDITIVE_WARNING } from '../src/report-warnings.js';
import { createLogger } from '../src/log.js';
import { counted, definitionFor, makeCtx, NETWORK, ok } from './helpers.js';

const RANGE = { start: '2026-09-01', end: '2026-09-02' };
const query = { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] };
const request = { tool: 'test', query, dateRange: RANGE, summary: 'S' };
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ AD_UNIT_ID: i + 1, IMPRESSIONS: i }));
const result = (run: number) => `networks/${NETWORK}/reports/1/results/${run}`;

describe('the report path uses the result cache (spec §2.5)', () => {
  it('E1: a hit fetches a page of the cached result and runs nothing', async () => {
    const cache = createReportCache();
    const { ctx, counters } = counted({ reports: [{ query, rows: rows(3) }] }, { reportCache: cache });
    const miss = ok(await executeReport(ctx, request));
    const before = { ...counters };
    const hit = ok(await executeReport(ctx, request));
    expect(counters.report_lookups - before.report_lookups).toBe(0);
    expect(counters.report_definitions_created - before.report_definitions_created).toBe(0);
    expect(counters.report_jobs_created - before.report_jobs_created).toBe(0);
    expect(counters.poll_operations - before.poll_operations).toBe(0);
    expect(counters.report_pages_fetched - before.report_pages_fetched).toBe(1);
    expect(miss.provenance.cache).toEqual({ hit: false });
    expect(hit.provenance).toMatchObject({ result: miss.provenance.result, cache: { hit: true } });
    expect(hit.rows).toEqual(miss.rows);
    const entry = cache.get(definitionHash(definitionFor(query, RANGE)));
    expect(Object.keys(entry!)).toEqual(['kind', 'report', 'result', 'run_time', 'date_range', 'total_row_count', 'stored_at']);
  });

  it('E1: a hit serves every page to a tool that computes from rows', async () => {
    const { ctx, counters } = counted({ reports: [{ query, rows: rows(12_000) }] }, { reportCache: createReportCache() });
    const first = await executeReportRows(ctx, query, RANGE, 'test');
    const jobs = counters.report_jobs_created;
    const again = await executeReportRows(ctx, query, RANGE, 'test');
    if ('error' in first || 'error' in again) throw new Error('expected rows');
    expect(again.rows).toEqual(first.rows);
    expect(again.input).toEqual(first.input);
    expect(counters.report_jobs_created).toBe(jobs);
  });

  it('E2: a hit carries the same warnings as a miss, and the original run time', async () => {
    const reachQuery = {
      dimensions: ['LINE_ITEM_ID', 'LINE_ITEM_NAME'],
      metrics: ['UNIQUE_VISITORS', 'REACH_IMPRESSIONS', 'AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR'],
    };
    const ctx = makeCtx({
      reports: [{
        query: reachQuery,
        rows: [{
          LINE_ITEM_ID: 1, LINE_ITEM_NAME: 'Campaign A',
          UNIQUE_VISITORS: 10, REACH_IMPRESSIONS: 30, AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR: 3,
        }],
      }],
    }, { reportCache: createReportCache() });
    // GAM repeats a result's run time on every first page. This fake reports a
    // later time on the second fetch, so a hit that trusted the page would show it.
    const inner = ctx.client;
    let fetches = 0;
    ctx.client = {
      ...inner,
      fetchRows: async (r, p) => {
        const page = await inner.fetchRows(r, p);
        fetches += 1;
        return { ...page, runTime: fetches === 1 ? '2026-09-16T01:00:00Z' : '2026-09-16T02:00:00Z' };
      },
    };
    const args = reachReportTool.input.parse({ date_range: { start: '2026-09-01', end: '2026-09-10' }, by: 'line_item' });
    const miss = ok(await reachReportTool.handler(args, ctx));
    const hit = ok(await reachReportTool.handler(args, ctx));
    expect(fetches).toBe(2);
    expect(miss.warnings).toContain(REACH_NON_ADDITIVE_WARNING);
    expect(hit.warnings).toEqual(miss.warnings);
    expect(miss.provenance).toMatchObject({ cache: { hit: false }, run_time: '2026-09-16T01:00:00Z' });
    expect(hit.provenance).toMatchObject({ cache: { hit: true }, run_time: '2026-09-16T01:00:00Z' });
  });

  it('E3: after the TTL the next call runs the report again', async () => {
    let t = Date.parse('2026-09-17T04:00:00Z');
    const { ctx, counters } = counted({ reports: [{ query, rows: rows(1) }] }, {
      reportCache: createReportCache({ ttlMs: 60_000, now: () => t }),
    });
    ok(await executeReport(ctx, request));
    t += 59_999;
    expect(ok(await executeReport(ctx, request)).provenance.cache).toEqual({ hit: true });
    t += 1;
    expect(ok(await executeReport(ctx, request)).provenance).toMatchObject({ cache: { hit: false }, result: result(2) });
    expect(counters.report_jobs_created).toBe(2);
    expect(counters.report_definitions_created).toBe(1);
  });

  it('E3: GAM_REPORT_CACHE_TTL_MS=0 never reuses a result', async () => {
    const { ctx, counters } = counted({ reports: [{ query, rows: rows(1) }] }, {
      reportCache: createReportCache({ ttlMs: 0 }),
    });
    for (let run = 1; run <= 3; run++) {
      expect(ok(await executeReport(ctx, request)).provenance).toMatchObject({ cache: { hit: false }, result: result(run) });
    }
    expect(counters.report_jobs_created).toBe(3);
    expect(counters.report_definitions_created).toBe(1);
    expect(counters.report_lookups).toBe(1);
  });

  it('E5: a cached result GAM no longer serves is run again once, silently', async () => {
    const expired: string[] = [];
    const { ctx, counters } = counted({ reports: [{ query, rows: rows(2) }], expiredResults: expired }, {
      reportCache: createReportCache(),
    });
    const first = ok(await executeReport(ctx, request));
    expired.push(result(1));
    const second = ok(await executeReport(ctx, request));
    expect(second.provenance).toMatchObject({ result: result(2), cache: { hit: false } });
    expect(second.warnings).toEqual(first.warnings);
    expect(second.rows).toEqual(first.rows);
    expect(counters.report_jobs_created).toBe(2);
  });

  it('E5: if the new result is gone too, the call is REPORT_RESULT_EXPIRED, once, with no loop', async () => {
    const expired: string[] = [];
    const { ctx, counters } = counted({ reports: [{ query, rows: rows(2) }], expiredResults: expired }, {
      reportCache: createReportCache(),
    });
    ok(await executeReport(ctx, request));
    expired.push(result(1), result(2));
    expect(await executeReport(ctx, request)).toMatchObject({
      error: { code: 'REPORT_RESULT_EXPIRED', details: { result: result(2) } },
    });
    expect(counters.report_jobs_created).toBe(2);
    // Nothing stale is left behind: the next call runs afresh.
    expect(ok(await executeReport(ctx, request)).provenance.result).toBe(result(3));
  });

  it('E7: the cache key and the report name come from the same hash', async () => {
    const keys: string[] = [];
    const cache = createReportCache();
    const spy: ReportCache = { ...cache, get: (key) => { keys.push(key); return cache.get(key); } };
    const ctx = makeCtx({ reports: [{ query, rows: rows(1) }] }, { reportCache: spy });
    const r = ok(await executeReport(ctx, request));
    const stored = await ctx.client.getReport(r.provenance.report);
    expect(keys).toEqual([definitionHash(stored!.definition)]);
    expect(stored!.displayName).toBe(reportName(keys[0]));
  });

  it('names the calling tool when it serves a cached result', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'info', sink: (l) => { lines.push(JSON.parse(l)); } });
    const { ctx } = counted({ reports: [{ query, rows: rows(1) }] }, { reportCache: createReportCache(), logger });
    await executeReport(ctx, request);
    await executeReport(ctx, { ...request, tool: 'second_tool' });
    expect(lines.find((e) => e.msg === 'report.cache_hit')).toMatchObject({ tool: 'second_tool', result: result(1) });
  });
});
