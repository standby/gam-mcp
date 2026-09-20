import { describe, it, expect } from 'vitest';
import { diagnoseFloorPricingTool } from '../../src/tools/diagnose_floor_pricing.js';
import { makeCtx } from '../helpers.js';

const QUERY = {
  dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
  metrics: [
    'AD_EXCHANGE_TOTAL_REQUESTS',
    'AD_EXCHANGE_MATCH_RATE',
    'AD_EXCHANGE_AVERAGE_ECPM',
    'AD_EXCHANGE_IMPRESSIONS',
    'AD_EXCHANGE_REVENUE',
  ],
};

const HEADER = [
  'AD_UNIT_ID',
  'AD_UNIT_NAME',
  'AD_EXCHANGE_TOTAL_REQUESTS',
  'AD_EXCHANGE_MATCH_RATE',
  'AD_EXCHANGE_AVERAGE_ECPM',
  'AD_EXCHANGE_IMPRESSIONS',
  'AD_EXCHANGE_REVENUE',
] as const;

// Zips a HEADER-ordered value tuple into a typed fixture row.
function row(vals: (string | number)[]): Record<string, string | number> {
  return Object.fromEntries(HEADER.map((h, i) => [h, vals[i]]));
}

function run(rows: Record<string, string | number>[], args: Record<string, unknown> = {}) {
  const ctx = makeCtx({ reports: [{ query: QUERY, rows }] }, {
    timezone: 'UTC',
    now: new Date('2026-05-01T12:00:00Z'),
  });
  return diagnoseFloorPricingTool.handler(diagnoseFloorPricingTool.input.parse(args), ctx);
}

describe('diagnose_floor_pricing', () => {
  it('classifies low-match/high-eCPM as floor_likely_high and high-match/low-eCPM as floor_likely_low', async () => {
    // Two units straddle the medians (match median = 0.5, eCPM median = 2.0).
    const rows = [
      row([1, 'HighFloor', 1000000, 0.30, 3.00, 300000, 900]), // low match, high eCPM
      row([2, 'LowFloor', 1000000, 0.80, 1.00, 800000, 800]),  // high match, low eCPM
    ];
    const r = await run(rows);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const byName = Object.fromEntries(r.rows!.map((row) => [row.AD_UNIT_NAME, row.verdict]));
    expect(byName.HighFloor).toBe('floor_likely_high');
    expect(byName.LowFloor).toBe('floor_likely_low');
  });

  it('skips ad units below min_requests', async () => {
    const rows = [
      row([1, 'Busy', 1000000, 0.50, 2.00, 500000, 1000]),
      row([2, 'Thin', 100, 0.10, 5.00, 10, 5]),
    ];
    const r = await run(rows, { min_requests: 1000 });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
    expect(r.rows![0].AD_UNIT_NAME).toBe('Busy');
  });

  it('ranks by estimated opportunity (floor_likely_high first)', async () => {
    // medians (3 rows): match=0.50, eCPM=2.00
    const rows = [
      row([1, 'HighFloor', 2000000, 0.20, 5.00, 400000, 2000]),  // low match, high eCPM, big unmatched volume → big opportunity
      row([2, 'Mid', 1000000, 0.50, 2.00, 500000, 1000]),        // at both medians → balanced, opp 0
      row([3, 'LowFloorBig', 1000000, 0.90, 1.00, 900000, 900]), // high match, low eCPM → floor_likely_low, smaller opp
    ];
    const r = await run(rows);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.rows![0].AD_UNIT_NAME).toBe('HighFloor');
    expect(r.rows![0].verdict).toBe('floor_likely_high');
    const d = r.rows![0].derived as Record<string, any>;
    expect(d.heuristic).toBe(true);
    expect(typeof d.method).toBe('string');
    expect(d.method).toContain('floor_likely_high');
    expect(Number(d.value)).toBeGreaterThan(0);
  });

  it('a missing AD_EXCHANGE_MATCH_RATE gives a null verdict and a null est_opportunity, not a guess', async () => {
    // Real, present values everywhere except AD_EXCHANGE_MATCH_RATE, so a
    // gating bug (treating the missing rate as 0) would be observable as a
    // concrete wrong verdict instead of null.
    const rows = [
      { AD_UNIT_ID: 1, AD_UNIT_NAME: 'Gappy', AD_EXCHANGE_TOTAL_REQUESTS: 1_000_000, AD_EXCHANGE_AVERAGE_ECPM: 3.0, AD_EXCHANGE_IMPRESSIONS: 300_000, AD_EXCHANGE_REVENUE: 900 },
      { AD_UNIT_ID: 2, AD_UNIT_NAME: 'Complete', AD_EXCHANGE_TOTAL_REQUESTS: 1_000_000, AD_EXCHANGE_MATCH_RATE: 0.5, AD_EXCHANGE_AVERAGE_ECPM: 2.0, AD_EXCHANGE_IMPRESSIONS: 500_000, AD_EXCHANGE_REVENUE: 1000 },
    ];
    const r = await run(rows);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const gappy = r.rows!.find((row) => row.AD_UNIT_NAME === 'Gappy')!;
    expect(gappy.verdict).toBeNull();
    const d = gappy.derived as Record<string, any>;
    expect(d.value).toBeNull();
    expect(d.heuristic).toBe(true);
    expect(gappy.adx_match_rate_pct).toBeNull();
    expect((r as { warnings: string[] }).warnings).toContain('1 row(s) had a null input to a computed field; such a row may appear in the results with a null value, or be excluded from the results entirely, depending on the tool.');
  });

  // Fix round 1, Important 1: a row can reach a real (non-null) verdict --
  // floor_likely_low needs only match rate/eCPM to classify -- while its
  // est_opportunity still comes out null because the formula for THAT
  // verdict needs a further input (AD_EXCHANGE_IMPRESSIONS) that wasn't
  // reported. This must still be counted in null_input_rows: the counter
  // reads the outcome (did derived.value come out null?), not a hand-written
  // "which inputs are required for a verdict" list, so it can't miss a case
  // like this one where the missing input only matters to the estimate.
  it('a missing AD_EXCHANGE_IMPRESSIONS on a floor_likely_low row gives a real verdict but a null est_opportunity, counted as a null input', async () => {
    const rows = [
      // matchRate/ecpm present and real; AD_EXCHANGE_IMPRESSIONS omitted.
      { AD_UNIT_ID: 1, AD_UNIT_NAME: 'Gappy', AD_EXCHANGE_TOTAL_REQUESTS: 1_000_000, AD_EXCHANGE_MATCH_RATE: 0.80, AD_EXCHANGE_AVERAGE_ECPM: 1.00, AD_EXCHANGE_REVENUE: 800 },
      // Complete counterpart, sets the medians (match=0.65, eCPM=1.50) and
      // itself lands on floor_likely_high, where impressions isn't needed.
      { AD_UNIT_ID: 2, AD_UNIT_NAME: 'Complete', AD_EXCHANGE_TOTAL_REQUESTS: 1_000_000, AD_EXCHANGE_MATCH_RATE: 0.50, AD_EXCHANGE_AVERAGE_ECPM: 2.00, AD_EXCHANGE_IMPRESSIONS: 500_000, AD_EXCHANGE_REVENUE: 1000 },
    ];
    const r = await run(rows);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const gappy = r.rows!.find((row) => row.AD_UNIT_NAME === 'Gappy')!;
    // Real verdict: match rate/eCPM were both known, so classification ran.
    expect(gappy.verdict).toBe('floor_likely_low');
    expect(gappy.adx_match_rate_pct).not.toBeNull();
    expect(gappy.adx_ecpm).not.toBeNull();
    // But the estimate itself is null -- it needed impressions, which GAM
    // didn't report -- not a guessed or zeroed number.
    const d = gappy.derived as Record<string, any>;
    expect(d.value).toBeNull();
    expect(d.heuristic).toBe(true);
    expect(gappy.adx_impressions).toBeNull();
    expect((r as { warnings: string[] }).warnings).toContain('1 row(s) had a null input to a computed field; such a row may appear in the results with a null value, or be excluded from the results entirely, depending on the tool.');
  });

  it('names the single input report in provenance', async () => {
    const rows = [row([1, 'Busy', 1000000, 0.50, 2.00, 500000, 1000])];
    const r = await run(rows);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const inputs = (r as { provenance: { inputs: unknown[] } }).provenance.inputs;
    expect(inputs).toHaveLength(1);
  });
});
