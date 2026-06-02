import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { yieldBreakdownTool } from '../../src/tools/yield_breakdown.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

const METRICS = [
  'YIELD_GROUP_IMPRESSIONS',
  'YIELD_GROUP_ESTIMATED_REVENUE',
  'YIELD_GROUP_ESTIMATED_CPM',
  'YIELD_GROUP_MEDIATION_FILL_RATE',
  'YIELD_GROUP_MEDIATION_PASSBACKS',
];

describe('yield_breakdown', () => {
  it('breaks down by Open Bidding partner with yield-group metrics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yb-'));
    const csv =
      'yield_group_buyer_name,yield_group_impressions,yield_group_estimated_revenue,yield_group_estimated_cpm,yield_group_mediation_fill_rate,yield_group_mediation_passbacks\n' +
      'PartnerA,1000000,1500,1.5,0.62,40000\n' +
      'PartnerB,500000,1000,2.0,0.31,210000\n';
    const args = yieldBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
    });
    const r = await yieldBreakdownTool.handler(args, {
      client: createMockGamClient({
        reports: [{
          query: { dimensions: ['YIELD_GROUP_BUYER_NAME'], metrics: METRICS },
          csvGz: gzipSync(Buffer.from(csv)),
        }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('breaks down by yield group with a secondary slice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yb-'));
    const csv =
      'yield_group_name,date,yield_group_impressions,yield_group_estimated_revenue,yield_group_estimated_cpm,yield_group_mediation_fill_rate,yield_group_mediation_passbacks\n' +
      'Display Mediation,2026-04-01,500000,750,1.5,0.5,10000\n' +
      'Display Mediation,2026-04-02,500000,750,1.5,0.5,10000\n';
    const args = yieldBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-02' },
      by: 'yield_group',
      group_by: 'day',
    });
    const r = await yieldBreakdownTool.handler(args, {
      client: createMockGamClient({
        reports: [{
          query: { dimensions: ['YIELD_GROUP_NAME', 'DATE'], metrics: METRICS },
          csvGz: gzipSync(Buffer.from(csv)),
        }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
