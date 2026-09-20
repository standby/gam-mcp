import { describe, it, expect } from 'vitest';
import { diagnoseFillRateTool } from '../../src/tools/diagnose_fill_rate.js';
import { makeCtx } from '../helpers.js';

// Matches the metrics order in diagnose_fill_rate.ts. FILL_RATE was replaced
// by IMPRESSIONS -- fill rate is now computed locally as IMPRESSIONS /
// AD_REQUESTS so a missing AD_REQUESTS propagates to a null cause instead of
// trusting GAM's own FILL_RATE metric independently of AD_REQUESTS.
const HEADER = [
  'AD_UNIT_ID',
  'AD_UNIT_NAME',
  'AD_REQUESTS',
  'AD_EXCHANGE_TOTAL_REQUESTS',
  'AD_EXCHANGE_MATCH_RATE',
  'AD_SERVER_RESPONSES_SERVED',
  'UNFILLED_IMPRESSIONS',
  'IMPRESSIONS',
] as const;

const QUERY = {
  dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
  metrics: [
    'AD_REQUESTS',
    'AD_EXCHANGE_TOTAL_REQUESTS',
    'AD_EXCHANGE_MATCH_RATE',
    'AD_SERVER_RESPONSES_SERVED',
    'UNFILLED_IMPRESSIONS',
    'IMPRESSIONS',
  ],
};

// Zips a HEADER-ordered value tuple into a typed fixture row. The last value
// is IMPRESSIONS; pass fillRate * AD_REQUESTS to land on a chosen fill rate.
function row(vals: (string | number)[]): Record<string, string | number> {
  return Object.fromEntries(HEADER.map((h, i) => [h, vals[i]]));
}

function derivedOf(row: Record<string, unknown>): Record<string, any> {
  return row.derived as Record<string, any>;
}

// At now=2026-04-15: base=last_7_days = [2026-04-08..2026-04-14], prev = [2026-04-01..2026-04-07].
const NOW = new Date('2026-04-15T12:00:00Z');
const BASE_RANGE = { start: '2026-04-08', end: '2026-04-14' };
const PREV_RANGE = { start: '2026-04-01', end: '2026-04-07' };

describe('diagnose_fill_rate', () => {
  it('attributes a single primary cause per ad unit (no-comparison path)', async () => {
    // One row per cause class, IMPRESSIONS = fillRate * AD_REQUESTS.
    const rows = [
      // healthy: fill_rate >= 0.85 (0.90 * 10000)
      row([1, 'Healthy',    10000, 9000, 0.80, 5000, 1000, 9000]),
      // tag_integration: adx_request_share < 0.10 (0.40 * 10000)
      row([2, 'TagBroken',  10000,  500, 0.50, 4000, 6000, 4000]),
      // low_match_rate: adx_share OK, adx_match < 0.30 (0.40 * 10000)
      row([3, 'LowMatch',   10000, 8000, 0.20, 4000, 6000, 4000]),
      // direct_underdelivery: upstream OK, direct_response_share < 0.20 (0.60 * 10000)
      row([4, 'DirectThin', 10000, 8000, 0.50, 1500, 4000, 6000]),
      // no_demand: upstream OK, unfilled_share > 0.50 (0.40 * 10000)
      row([5, 'NoBuyers',   10000, 8000, 0.50, 3000, 6000, 4000]),
      // mixed: nothing dominant (0.60 * 10000)
      row([6, 'Mixed',      10000, 8000, 0.50, 3000, 4000, 6000]),
      // below min_requests: filtered out (0.40 * 50)
      row([7, 'TooNew',        50,   50, 0.50,   20,   30, 20]),
    ];
    const ctx = makeCtx({ reports: [{ query: QUERY, rows }] }, { timezone: 'UTC', now: NOW });

    const r = await diagnoseFillRateTool.handler(
      diagnoseFillRateTool.input.parse({ comparison: 'none', top_n: 10 }),
      ctx,
    );
    if (!('rows' in r)) throw new Error(JSON.stringify(r));

    // TooNew is filtered out; six others present.
    const byName = Object.fromEntries(r.rows!.map((x) => [x.AD_UNIT_NAME, derivedOf(x).value]));
    expect(byName).toEqual({
      Healthy:    'healthy',
      TagBroken:  'tag_integration',
      LowMatch:   'low_match_rate',
      DirectThin: 'direct_underdelivery',
      NoBuyers:   'no_demand',
      Mixed:      'mixed',
    });
    expect(r.rows!.find((x) => x.AD_UNIT_NAME === 'TooNew')).toBeUndefined();
    for (const x of r.rows!) {
      const d = derivedOf(x);
      expect(d.heuristic).toBe(true);
      expect(typeof d.method).toBe('string');
      expect(d.inputs).toHaveProperty('IMPRESSIONS');
      expect(d.inputs).toHaveProperty('AD_REQUESTS');
    }
  });

  it('attributes demand_collapse when AdX match rate dropped ≥10pp WoW', async () => {
    const ctx = makeCtx({
      reports: [
        // Base: fill_rate 0.50 (well under the 0.85 healthy bar)
        {
          query: QUERY,
          dateRange: BASE_RANGE,
          rows: [row([10, 'CollapseUnit', 10000, 8000, 0.40, 4000, 5000, 5000])],
        },
        // Prev: match rate was 0.65 → 25pp drop, well past 10pp threshold
        {
          query: QUERY,
          dateRange: PREV_RANGE,
          rows: [row([10, 'CollapseUnit', 10000, 8000, 0.65, 4000, 2000, 8000])],
        },
      ],
    }, { timezone: 'UTC', now: NOW });

    const r = await diagnoseFillRateTool.handler(
      diagnoseFillRateTool.input.parse({}),
      ctx,
    );
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(derivedOf(r.rows![0]).value).toBe('demand_collapse');
    expect(r.rows![0].adx_match_rate_pct).toBe('40.00');
    expect(r.rows![0].adx_match_rate_prev_pct).toBe('65.00');
  });

  it('ranks results by unfilled_impressions descending (impact-aware)', async () => {
    const rows = [
      // Low absolute fill rate, but only 1500 unfilled imps — low impact
      row([1, 'ToyUnit',   2000, 1500, 0.20, 500, 1500, 500]),
      // Moderate fill rate but huge volume → biggest absolute impact
      row([2, 'WhaleUnit', 1_000_000, 800_000, 0.50, 200_000, 500_000, 500_000]),
      // Mid-tier
      row([3, 'MidUnit',   100_000, 80_000, 0.45, 30_000, 50_000, 50_000]),
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
        rows: [row([1, 'X', 10000, 8000, 0.50, 3000, 4000, 6000])],
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
        { query: QUERY, dateRange: BASE_RANGE, rows: [row([10, 'U', 10000, 8000, 0.40, 4000, 5000, 5000])] },
        { query: QUERY, dateRange: PREV_RANGE, rows: [row([10, 'U', 10000, 8000, 0.65, 4000, 2000, 8000])] },
      ],
    }, { timezone: 'UTC', now: NOW });
    const r = await diagnoseFillRateTool.handler(diagnoseFillRateTool.input.parse({}), ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const inputs = (r as { provenance: { inputs: unknown[] } }).provenance.inputs;
    expect(inputs).toHaveLength(2);
  });

  // I10 (spec §4.6): the fill-rate cause moves under derived with
  // heuristic: true, a stated method, and IMPRESSIONS among the inputs.
  it('I10: diagnose_fill_rate publishes IMPRESSIONS under derived with heuristic true', async () => {
    const rows = [row([1, 'Healthy', 10000, 9000, 0.80, 5000, 1000, 9000])];
    const ctx = makeCtx({ reports: [{ query: QUERY, rows }] }, { timezone: 'UTC', now: NOW });

    const r = await diagnoseFillRateTool.handler(
      diagnoseFillRateTool.input.parse({ comparison: 'none', top_n: 25, min_requests: 0 }),
      ctx,
    );
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    const d = derivedOf(r.rows![0]);
    expect(d.heuristic).toBe(true);
    expect(typeof d.method).toBe('string');
    expect(d.inputs).toHaveProperty('IMPRESSIONS');
    expect(d.value).toBe('healthy');
  });

  // Today, before this task, numOr0 turned a missing AD_REQUESTS into 0,
  // which made fillRate 0, which is not "healthy" -- but only by luck, not
  // by design. With real null propagation the row must get a null cause,
  // not a guessed one. Every OTHER field on the row is a real, present
  // number, so a gating bug (e.g. ratio() falling back to 0) is observable:
  // the row would read as a concrete, wrong cause instead of null.
  it('a missing AD_REQUESTS gives a null cause, not a healthy verdict by luck', async () => {
    const rows = [{
      AD_UNIT_ID: 1,
      AD_UNIT_NAME: 'Gappy',
      // AD_REQUESTS intentionally absent -- GAM did not report it for this row.
      AD_EXCHANGE_TOTAL_REQUESTS: 9000,
      AD_EXCHANGE_MATCH_RATE: 0.8,
      AD_SERVER_RESPONSES_SERVED: 5000,
      UNFILLED_IMPRESSIONS: 1000,
      IMPRESSIONS: 9000,
    }];
    const ctx = makeCtx({ reports: [{ query: QUERY, rows }] }, { timezone: 'UTC', now: NOW });

    const r = await diagnoseFillRateTool.handler(
      diagnoseFillRateTool.input.parse({ comparison: 'none', top_n: 25, min_requests: 0 }),
      ctx,
    );
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows).toHaveLength(1);
    const d = derivedOf(r.rows![0]);
    expect(d.value).toBeNull();
    expect(r.rows![0].ad_requests).toBeNull();
    expect(r.rows![0].fill_rate_pct).toBeNull();
    // The other, real inputs are still carried through -- this isn't a row
    // GAM sent nothing for.
    expect(d.inputs.IMPRESSIONS).toBe(9000);
    expect(d.inputs.AD_EXCHANGE_TOTAL_REQUESTS).toBe(9000);
    expect((r as { warnings: string[] }).warnings).toContain('1 row(s) had a null input to a computed field; such a row may appear in the results with a null value, or be excluded from the results entirely, depending on the tool.');
  });
});
