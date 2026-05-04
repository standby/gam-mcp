import { describe, it, expect } from 'vitest';
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
});
