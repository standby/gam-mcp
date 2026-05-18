import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageStatsTool } from '../../src/tools/usage_stats.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';
import { createUsageCounters } from '../../src/usage.js';
import { createReportCache } from '../../src/cache.js';

describe('usage_stats', () => {
  it('returns counters + cache hit-rate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'us-'));
    const usageCounters = createUsageCounters();
    usageCounters.report_jobs_created = 3;
    usageCounters.cumulative_report_latency_ms = 1500;
    const reportCache = createReportCache();
    // Simulate cache traffic
    reportCache.get({ dimensions: ['DATE'], metrics: ['REVENUE'] }, { start: '2026-04-01', end: '2026-04-01' }); // miss
    reportCache.set({ dimensions: ['DATE'], metrics: ['REVENUE'] }, { start: '2026-04-01', end: '2026-04-01' }, []);
    reportCache.get({ dimensions: ['DATE'], metrics: ['REVENUE'] }, { start: '2026-04-01', end: '2026-04-01' }); // hit

    const r = await usageStatsTool.handler({}, {
      client: createMockGamClient(),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
      usageCounters,
      reportCache,
    });
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows![0].report_jobs_created).toBe('3');
    expect(r.rows![0].cumulative_report_latency_ms).toBe('1500');
    expect(r.rows![0].report_cache_hits).toBe('1');
    expect(r.rows![0].report_cache_misses).toBe('1');
    expect(r.rows![0].report_cache_hit_rate_pct).toBe('50.0');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an error when usageCounters is not configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'us-'));
    const r = await usageStatsTool.handler({}, {
      client: createMockGamClient(),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    });
    expect('error' in r).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
