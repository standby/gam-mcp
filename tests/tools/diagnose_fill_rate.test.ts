import { describe, it, expect } from 'vitest';
import { diagnoseFillRateTool } from '../../src/tools/diagnose_fill_rate.js';
import { makeCtx } from '../helpers.js';

// Matches the metrics order in diagnose_fill_rate.ts.
const HEADER = [
  'AD_UNIT_ID',
  'AD_UNIT_NAME',
  'AD_REQUESTS',
  'AD_EXCHANGE_TOTAL_REQUESTS',
  'AD_EXCHANGE_MATCH_RATE',
  'AD_SERVER_RESPONSES_SERVED',
  'UNFILLED_IMPRESSIONS',
  'FILL_RATE',
] as const;

const QUERY = {
  dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
  metrics: [
    'AD_REQUESTS',
    'AD_EXCHANGE_TOTAL_REQUESTS',
    'AD_EXCHANGE_MATCH_RATE',
    'AD_SERVER_RESPONSES_SERVED',
    'UNFILLED_IMPRESSIONS',
    'FILL_RATE',
  ],
};

// Zips a HEADER-ordered value tuple into a typed fixture row.
function row(vals: (string | number)[]): Record<string, string | number> {
  return Object.fromEntries(HEADER.map((h, i) => [h, vals[i]]));
}

// At now=2026-04-15: base=last_7_days = [2026-04-08..2026-04-14], prev = [2026-04-01..2026-04-07].
const NOW = new Date('2026-04-15T12:00:00Z');
const BASE_RANGE = { start: '2026-04-08', end: '2026-04-14' };
const PREV_RANGE = { start: '2026-04-01', end: '2026-04-07' };

describe('diagnose_fill_rate', () => {
  it('attributes a single primary cause per ad unit (no-comparison path)', async () => {
    // One row per cause class. Crafted to exercise each priority-ordered rule.
    const rows = [
      // healthy: fill_rate >= 0.85
      row([1, 'Healthy',    10000, 9000, 0.80, 5000, 1000, 0.90]),
      // tag_integration: adx_request_share < 0.10
      row([2, 'TagBroken',  10000,  500, 0.50, 4000, 6000, 0.40]),
      // low_match_rate: adx_share OK, adx_match < 0.30
      row([3, 'LowMatch',   10000, 8000, 0.20, 4000, 6000, 0.40]),
      // direct_underdelivery: upstream OK, direct_response_share < 0.20
      row([4, 'DirectThin', 10000, 8000, 0.50, 1500, 4000, 0.60]),
      // no_demand: upstream OK, unfilled_share > 0.50
      row([5, 'NoBuyers',   10000, 8000, 0.50, 3000, 6000, 0.40]),
      // mixed: nothing dominant
      row([6, 'Mixed',      10000, 8000, 0.50, 3000, 4000, 0.60]),
      // below min_requests: filtered out
      row([7, 'TooNew',        50,   50, 0.50,   20,   30, 0.40]),
    ];
    const ctx = makeCtx({ reports: [{ query: QUERY, rows }] }, { timezone: 'UTC', now: NOW });

    const r = await diagnoseFillRateTool.handler(
      diagnoseFillRateTool.input.parse({ comparison: 'none', top_n: 10 }),
      ctx,
    );
    if (!('rows' in r)) throw new Error(JSON.stringify(r));

    // TooNew is filtered out; six others present.
    const byName = Object.fromEntries(r.rows!.map((x) => [x.AD_UNIT_NAME, x.cause]));
    expect(byName).toEqual({
      Healthy:    'healthy',
      TagBroken:  'tag_integration',
      LowMatch:   'low_match_rate',
      DirectThin: 'direct_underdelivery',
      NoBuyers:   'no_demand',
      Mixed:      'mixed',
    });
    expect(r.rows!.find((x) => x.AD_UNIT_NAME === 'TooNew')).toBeUndefined();
  });

  it('attributes demand_collapse when AdX match rate dropped ≥10pp WoW', async () => {
    const ctx = makeCtx({
      reports: [
        // Base: match rate now 0.40
        {
          query: QUERY,
          dateRange: BASE_RANGE,
          rows: [row([10, 'CollapseUnit', 10000, 8000, 0.40, 4000, 5000, 0.50])],
        },
        // Prev: match rate was 0.65 → 25pp drop, well past 10pp threshold
        {
          query: QUERY,
          dateRange: PREV_RANGE,
          rows: [row([10, 'CollapseUnit', 10000, 8000, 0.65, 4000, 2000, 0.80])],
        },
      ],
    }, { timezone: 'UTC', now: NOW });

    const r = await diagnoseFillRateTool.handler(
      diagnoseFillRateTool.input.parse({}),
      ctx,
    );
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows![0].cause).toBe('demand_collapse');
    expect(r.rows![0].adx_match_rate_pct).toBe('40.00');
    expect(r.rows![0].adx_match_rate_prev_pct).toBe('65.00');
  });

  it('ranks results by unfilled_impressions descending (impact-aware)', async () => {
    const rows = [
      // Low absolute fill rate, but only 200 unfilled imps — low impact
      row([1, 'ToyUnit',   2000, 1500, 0.20, 500, 1500, 0.25]),
      // Moderate fill rate but huge volume → biggest absolute impact
      row([2, 'WhaleUnit', 1_000_000, 800_000, 0.50, 200_000, 500_000, 0.50]),
      // Mid-tier
      row([3, 'MidUnit',   100_000, 80_000, 0.45, 30_000, 50_000, 0.50]),
    ];
    const ctx = makeCtx({ reports: [{ query: QUERY, rows }] }, { timezone: 'UTC', now: NOW });

    const r = await diagnoseFillRateTool.handler(
      diagnoseFillRateTool.input.parse({ comparison: 'none' }),
      ctx,
    );
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows!.map((x) => x.AD_UNIT_NAME)).toEqual(['WhaleUnit', 'MidUnit', 'ToyUnit']);
  });

  it('omits prev columns when comparison is disabled', async () => {
    const ctx = makeCtx({
      reports: [{
        query: QUERY,
        rows: [row([1, 'X', 10000, 8000, 0.50, 3000, 4000, 0.60])],
      }],
    }, { timezone: 'UTC', now: NOW });
    const r = await diagnoseFillRateTool.handler(
      diagnoseFillRateTool.input.parse({ comparison: 'none' }),
      ctx,
    );
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows![0]).not.toHaveProperty('fill_rate_prev_pct');
    expect(r.rows![0]).not.toHaveProperty('adx_match_rate_prev_pct');
  });

  it('names both input reports in provenance when comparing', async () => {
    const ctx = makeCtx({
      reports: [
        { query: QUERY, dateRange: BASE_RANGE, rows: [row([10, 'U', 10000, 8000, 0.40, 4000, 5000, 0.50])] },
        { query: QUERY, dateRange: PREV_RANGE, rows: [row([10, 'U', 10000, 8000, 0.65, 4000, 2000, 0.80])] },
      ],
    }, { timezone: 'UTC', now: NOW });
    const r = await diagnoseFillRateTool.handler(diagnoseFillRateTool.input.parse({}), ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const inputs = (r as { provenance: { inputs: unknown[] } }).provenance.inputs;
    expect(inputs).toHaveLength(2);
  });
});
