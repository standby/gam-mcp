import { describe, it, expect } from 'vitest';
import { createFakeGam, dbl, int, str } from '../fake-gam.js';
import { restCtx } from '../helpers.js';
import { topAdvertisersTool } from '../../src/tools/top_advertisers.js';
import { comparePeriodsTool } from '../../src/tools/compare_periods.js';

describe('I2: two advertisers with the same name stay separate', () => {
  it('top_advertisers keys on the ID, so a shared display name does not merge rows', async () => {
    const gam = createFakeGam();
    gam.setRows({ byColumn: [
      { ADVERTISER_ID: int(1), ADVERTISER_NAME: str('Same'), REVENUE: dbl(100) },
      { ADVERTISER_ID: int(2), ADVERTISER_NAME: str('Same'), REVENUE: dbl(50) },
    ]});
    // buildReportTool's handler skips zod parsing on a direct .handler() call,
    // so date_range gets no default here — it must be supplied explicitly.
    const r = await topAdvertisersTool.handler(
      { date_range: { relative: 'last_7_days' }, top_n: 10, metric: 'revenue' } as never,
      restCtx(gam),
    ) as Record<string, any>;
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x: any) => x.ADVERTISER_ID).sort()).toEqual([1, 2]);
  });
});

describe('I3: a duplicated join key is refused, not merged', () => {
  it('returns DUPLICATE_JOIN_KEY naming the key and the period', async () => {
    const gam = createFakeGam();
    // The same tuple twice in the base period.
    gam.setRows({ byColumn: [
      { ADVERTISER_ID: int(1), REVENUE: dbl(100) },
      { ADVERTISER_ID: int(1), REVENUE: dbl(50) },
    ]});
    const r = await comparePeriodsTool.handler({
      dimensions: ['ADVERTISER_ID'], metrics: ['REVENUE'],
      base_range: { relative: 'last_7_days' }, top_n: 10,
    } as never, restCtx(gam)) as Record<string, any>;
    expect(r.error?.code).toBe('DUPLICATE_JOIN_KEY');
    expect(JSON.stringify(r.error.details)).toContain('1');
  });
});
