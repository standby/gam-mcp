import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseFloorPricingTool } from '../../src/tools/diagnose_floor_pricing.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

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

const header =
  'AD_UNIT_ID,AD_UNIT_NAME,AD_EXCHANGE_TOTAL_REQUESTS,AD_EXCHANGE_MATCH_RATE,AD_EXCHANGE_AVERAGE_ECPM,AD_EXCHANGE_IMPRESSIONS,AD_EXCHANGE_REVENUE\n';

function run(csv: string, args: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-'));
  return diagnoseFloorPricingTool
    .handler(diagnoseFloorPricingTool.input.parse(args), {
      client: createMockGamClient({ reports: [{ query: QUERY, csvGz: gzipSync(Buffer.from(header + csv)) }] }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 100_000 }),
      timezone: 'UTC',
      logger: noopLogger(),
      now: new Date('2026-05-01T12:00:00Z'),
    })
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('diagnose_floor_pricing', () => {
  it('classifies low-match/high-eCPM as floor_likely_high and high-match/low-eCPM as floor_likely_low', async () => {
    // Two units straddle the medians (match median = 0.5, eCPM median = 2.0).
    const csv =
      '1,HighFloor,1000000,0.30,3.00,300000,900\n' + // low match, high eCPM
      '2,LowFloor,1000000,0.80,1.00,800000,800\n';   // high match, low eCPM
    const r = await run(csv);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const byName = Object.fromEntries(r.rows!.map((row) => [row.AD_UNIT_NAME, row.verdict]));
    expect(byName.HighFloor).toBe('floor_likely_high');
    expect(byName.LowFloor).toBe('floor_likely_low');
  });

  it('skips ad units below min_requests', async () => {
    const csv =
      '1,Busy,1000000,0.50,2.00,500000,1000\n' +
      '2,Thin,100,0.10,5.00,10,5\n';
    const r = await run(csv, { min_requests: 1000 });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    expect(r.rows![0].AD_UNIT_NAME).toBe('Busy');
  });

  it('ranks by estimated opportunity (floor_likely_high first)', async () => {
    // medians (3 rows): match=0.50, eCPM=2.00
    const csv =
      '1,HighFloor,2000000,0.20,5.00,400000,2000\n' + // low match, high eCPM, big unmatched volume → big opportunity
      '2,Mid,1000000,0.50,2.00,500000,1000\n' +        // at both medians → balanced, opp 0
      '3,LowFloorBig,1000000,0.90,1.00,900000,900\n';  // high match, low eCPM → floor_likely_low, smaller opp
    const r = await run(csv);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.rows![0].AD_UNIT_NAME).toBe('HighFloor');
    expect(r.rows![0].verdict).toBe('floor_likely_high');
    expect(Number(r.rows![0].est_opportunity)).toBeGreaterThan(0);
  });
});
