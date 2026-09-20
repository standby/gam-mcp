import { describe, it, expect } from 'vitest';
import { createFakeGam, dbl, int, str } from '../fake-gam.js';
import { restCtx, makeCtx } from '../helpers.js';
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

  // Spec §7.2's I2 names both tools: the same shared-name-different-ID
  // scenario must also stay separate when it is compare_periods, not
  // top_advertisers, doing the grouping — compare_periods joins on whatever
  // dimension tuple the caller passes, so including the ID keeps the two
  // "Same"-named advertisers as two distinct keys instead of one merged row.
  it('compare_periods keys on the full dimension tuple, so a shared display name does not merge rows', async () => {
    const gam = createFakeGam();
    gam.setRows({ byColumn: [
      { ADVERTISER_ID: int(1), ADVERTISER_NAME: str('Same'), REVENUE: dbl(100) },
      { ADVERTISER_ID: int(2), ADVERTISER_NAME: str('Same'), REVENUE: dbl(50) },
    ]});
    const args = comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_ID', 'ADVERTISER_NAME'],
      metrics: ['REVENUE'],
      base_range: { relative: 'last_7_days' },
      comparison: 'previous_period',
      top_n: 10,
    });
    const r = await comparePeriodsTool.handler(args, restCtx(gam)) as Record<string, any>;
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(2);
    // compare_periods's output rows are string-valued (built via cellText).
    expect(r.rows.map((x: any) => x.ADVERTISER_ID).sort()).toEqual(['1', '2']);
  });
});

describe('I3: a duplicated join key is refused, not merged', () => {
  it('returns DUPLICATE_JOIN_KEY naming the key and the period (duplicate present in both periods)', async () => {
    const gam = createFakeGam();
    // The same tuple twice, in a fixture returned for BOTH periods:
    // createFakeGam()'s rowsFor() ignores dateRange, so this only proves a
    // duplicate is detected somewhere — it cannot tell which side's check
    // found it. See the two cases below for that.
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

  // Unlike createFakeGam(), createMockGamClient's fixtures are matched by
  // dateRange too (src/gam-client.ts matchFixture), so each period can be
  // given genuinely different rows. This is the case the original I3 could
  // not express: a duplicate confined to ONE period. A regression to
  // "only check prevByKey" (finding F8's exact shape) would silently pass
  // this base-period duplicate through — this test exists to catch that.
  it('returns DUPLICATE_JOIN_KEY for a duplicate confined to the base period only', async () => {
    const query = { dimensions: ['ADVERTISER_ID'], metrics: ['REVENUE'] };
    const ctx = makeCtx({
      reports: [
        {
          query,
          dateRange: { start: '2026-04-23', end: '2026-04-29' },
          rows: [
            { ADVERTISER_ID: 1, REVENUE: 100 },
            { ADVERTISER_ID: 1, REVENUE: 50 },
          ],
        },
        {
          query,
          dateRange: { start: '2026-04-16', end: '2026-04-22' },
          rows: [
            { ADVERTISER_ID: 1, REVENUE: 10 },
            { ADVERTISER_ID: 2, REVENUE: 20 },
          ],
        },
      ],
    }, { timezone: 'UTC' });
    const args = comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_ID'],
      metrics: ['REVENUE'],
      base_range: { start: '2026-04-23', end: '2026-04-29' },
      comparison: 'previous_period',
      top_n: 10,
    });
    const r = await comparePeriodsTool.handler(args, ctx) as Record<string, any>;
    expect(r.error?.code).toBe('DUPLICATE_JOIN_KEY');
    expect(r.error?.details?.period).toBe('base');
  });

  // The mirror of the case above: the duplicate is confined to the previous
  // period only, with the base period clean. A regression to "only check
  // baseByKey" would silently pass this one through instead.
  it('returns DUPLICATE_JOIN_KEY for a duplicate confined to the previous period only', async () => {
    const query = { dimensions: ['ADVERTISER_ID'], metrics: ['REVENUE'] };
    const ctx = makeCtx({
      reports: [
        {
          query,
          dateRange: { start: '2026-04-23', end: '2026-04-29' },
          rows: [
            { ADVERTISER_ID: 1, REVENUE: 100 },
            { ADVERTISER_ID: 2, REVENUE: 200 },
          ],
        },
        {
          query,
          dateRange: { start: '2026-04-16', end: '2026-04-22' },
          rows: [
            { ADVERTISER_ID: 1, REVENUE: 10 },
            { ADVERTISER_ID: 1, REVENUE: 20 },
          ],
        },
      ],
    }, { timezone: 'UTC' });
    const args = comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_ID'],
      metrics: ['REVENUE'],
      base_range: { start: '2026-04-23', end: '2026-04-29' },
      comparison: 'previous_period',
      top_n: 10,
    });
    const r = await comparePeriodsTool.handler(args, ctx) as Record<string, any>;
    expect(r.error?.code).toBe('DUPLICATE_JOIN_KEY');
    expect(r.error?.details?.period).toBe('previous');
  });
});
