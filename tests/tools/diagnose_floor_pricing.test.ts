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
    expect((r as { warnings: string[] }).warnings).toContain('1 row(s) had a null input to a computed field.');
  });

  it('names the single input report in provenance', async () => {
    const rows = [row([1, 'Busy', 1000000, 0.50, 2.00, 500000, 1000])];
    const r = await run(rows);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const inputs = (r as { provenance: { inputs: unknown[] } }).provenance.inputs;
    expect(inputs).toHaveLength(1);
  });
});
