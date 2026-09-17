import { describe, it, expect } from 'vitest';
import { usageStatsTool } from '../../src/tools/usage_stats.js';
import { makeCtx, NETWORK } from '../helpers.js';
import { createUsageCounters, instrumentGamClient } from '../../src/usage.js';
import { createReportCache } from '../../src/cache.js';
import { executeReport } from '../../src/report-exec.js';

describe('usage_stats', () => {
  it('returns the counters and the hit rate of the result cache', async () => {
    const usageCounters = createUsageCounters();
    usageCounters.report_jobs_created = 3;
    usageCounters.cumulative_report_latency_ms = 1500;
    const reportCache = createReportCache({ networkCode: NETWORK });
    const key = 'd'.repeat(64);
    reportCache.get(key); // miss
    reportCache.putDone(key, {
      report: 'networks/1234/reports/1',
      result: 'networks/1234/reports/1/results/1',
      run_time: '2026-09-17T03:00:00Z',
      date_range: { start: '2026-09-01', end: '2026-09-01' },
      total_row_count: 0,
    });
    reportCache.get(key); // hit

    const r = await usageStatsTool.handler({}, makeCtx({}, { usageCounters, reportCache }));
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows[0]).toMatchObject({
      report_jobs_created: 3,
      cumulative_report_latency_ms: 1500,
      report_cache_hits: 1,
      report_cache_misses: 1,
      report_cache_hit_rate_pct: '50.0',
    });
  });

  it('returns an error when usageCounters is not configured', async () => {
    const r = await usageStatsTool.handler({}, makeCtx());
    expect('error' in r).toBe(true);
  });

  it('counts what a miss and then a hit really cost', async () => {
    const query = { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] };
    const usageCounters = createUsageCounters();
    const reportCache = createReportCache({ networkCode: NETWORK });
    const ctx = makeCtx({ reports: [{ query, rows: [{ AD_UNIT_ID: 1, IMPRESSIONS: 2 }] }] }, { usageCounters, reportCache });
    ctx.client = instrumentGamClient(ctx.client, usageCounters);
    const request = { tool: 'test', query, dateRange: { start: '2026-09-01', end: '2026-09-01' }, summary: 'S' };
    await executeReport(ctx, request); // miss: list, create, run, two polls, first page
    await executeReport(ctx, request); // hit: the cached result's first page only
    const r = await usageStatsTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows[0]).toMatchObject({
      report_definitions_created: 1,
      report_jobs_created: 1,
      poll_operations: 2,
      report_pages_fetched: 2,
      report_lookups: 1,
      report_cache_hits: 1,
      report_cache_misses: 1,
      report_cache_hit_rate_pct: '50.0',
    });
  });
});
