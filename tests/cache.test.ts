import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReportCache } from '../src/cache.js';
import type { ReportQuery, DateRange } from '../src/gam-client.js';

const dr: DateRange = { start: '2026-04-01', end: '2026-04-07' };
const drOther: DateRange = { start: '2026-03-01', end: '2026-03-07' };

describe('ReportCache', () => {
  it('hits when query and date range match exactly', () => {
    const c = createReportCache();
    const q: ReportQuery = { dimensions: ['DATE'], metrics: ['IMPRESSIONS'] };
    c.set(q, dr, [{ DATE: '20260401', IMPRESSIONS: '100' }]);
    expect(c.get(q, dr)).toEqual([{ DATE: '20260401', IMPRESSIONS: '100' }]);
  });

  it('misses when date range differs', () => {
    const c = createReportCache();
    const q: ReportQuery = { dimensions: ['DATE'], metrics: ['IMPRESSIONS'] };
    c.set(q, dr, [{ DATE: '20260401', IMPRESSIONS: '100' }]);
    expect(c.get(q, drOther)).toBeUndefined();
  });

  it('treats different dimension/metric ORDER as the same query', () => {
    const c = createReportCache();
    const q1: ReportQuery = { dimensions: ['DATE', 'ADVERTISER_NAME'], metrics: ['IMPRESSIONS', 'REVENUE'] };
    const q2: ReportQuery = { dimensions: ['ADVERTISER_NAME', 'DATE'], metrics: ['REVENUE', 'IMPRESSIONS'] };
    c.set(q1, dr, [{ x: '1' }]);
    expect(c.get(q2, dr)).toEqual([{ x: '1' }]);
  });

  it('treats custom_dimension_key_ids ORDER as significant (positional)', () => {
    const c = createReportCache();
    const q1: ReportQuery = { dimensions: ['CUSTOM_DIMENSION_0_VALUE'], metrics: ['IMPRESSIONS'], custom_dimension_key_ids: [111, 222] };
    const q2: ReportQuery = { dimensions: ['CUSTOM_DIMENSION_0_VALUE'], metrics: ['IMPRESSIONS'], custom_dimension_key_ids: [222, 111] };
    c.set(q1, dr, [{ x: 'a' }]);
    expect(c.get(q2, dr)).toBeUndefined();
  });

  it('treats different filters as different queries', () => {
    const c = createReportCache();
    const q1: ReportQuery = { dimensions: ['DATE'], metrics: ['IMPRESSIONS'], filters: [{ field: 'AD_UNIT_ID', op: '=', value: 1 }] };
    const q2: ReportQuery = { dimensions: ['DATE'], metrics: ['IMPRESSIONS'], filters: [{ field: 'AD_UNIT_ID', op: '=', value: 2 }] };
    c.set(q1, dr, [{ x: '1' }]);
    expect(c.get(q2, dr)).toBeUndefined();
  });

  it('tracks hits and misses for usage stats', () => {
    const c = createReportCache();
    const q: ReportQuery = { dimensions: ['DATE'], metrics: ['IMPRESSIONS'] };
    expect(c.stats()).toEqual({ hits: 0, misses: 0 });
    c.get(q, dr); // miss
    c.set(q, dr, [{ x: '1' }]);
    c.get(q, dr); // hit
    c.get(q, drOther); // miss
    expect(c.stats()).toEqual({ hits: 1, misses: 2 });
  });
});

describe('ReportCache disk tier', () => {
  it('persists rows to disk and serves them on a fresh instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-'));
    const q: ReportQuery = { dimensions: ['DATE'], metrics: ['IMPRESSIONS'] };
    const c1 = createReportCache({ diskDir: dir });
    c1.set(q, dr, [{ DATE: '20260401', IMPRESSIONS: '100' }]);
    // A different process / fresh instance should still hit on the same key.
    const c2 = createReportCache({ diskDir: dir });
    expect(c2.get(q, dr)).toEqual([{ DATE: '20260401', IMPRESSIONS: '100' }]);
    // And the disk hit promotes to in-memory for cheap subsequent hits.
    expect(c2.stats().hits).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('expires entries past ttlMs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-'));
    const q: ReportQuery = { dimensions: ['DATE'], metrics: ['IMPRESSIONS'] };
    // 50ms TTL — write, sleep, read.
    const c1 = createReportCache({ diskDir: dir, ttlMs: 50 });
    c1.set(q, dr, [{ x: '1' }]);
    await new Promise((r) => setTimeout(r, 80));
    const c2 = createReportCache({ diskDir: dir, ttlMs: 50 });
    expect(c2.get(q, dr)).toBeUndefined();
    // Stale file is opportunistically removed on read.
    expect(readdirSync(dir).length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the cache dir if it does not exist', () => {
    const parent = mkdtempSync(join(tmpdir(), 'rc-'));
    const dir = join(parent, 'nested', 'cache');
    createReportCache({ diskDir: dir });
    expect(existsSync(dir)).toBe(true);
    rmSync(parent, { recursive: true, force: true });
  });
});
