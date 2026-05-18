import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bidderBreakdownTool } from '../../src/tools/bidder_breakdown.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

describe('bidder_breakdown', () => {
  it('queries BIDDER_NAME with AdX-only metrics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-'));
    const csv =
      'bidder_name,ad_exchange_impressions,ad_exchange_revenue,ad_exchange_average_ecpm\n' +
      'BidderA,1000000,1500,1.5\n' +
      'BidderB,500000,1000,2.0\n' +
      ',2000000,800,0.4\n'; // unnamed = non-bidder AdX/AdSense baseline
    const args = bidderBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
    });
    const r = await bidderBreakdownTool.handler(args, {
      client: createMockGamClient({
        reports: [{
          query: {
            dimensions: ['BIDDER_NAME'],
            metrics: [
              'AD_EXCHANGE_IMPRESSIONS',
              'AD_EXCHANGE_REVENUE',
              'AD_EXCHANGE_AVERAGE_ECPM',
            ],
          },
          csvGz: gzipSync(Buffer.from(csv)),
        }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds secondary dimension when group_by is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-'));
    const csv =
      'bidder_name,date,ad_exchange_impressions,ad_exchange_revenue,ad_exchange_average_ecpm\n' +
      'BidderA,2026-04-01,500000,750,1.5\n' +
      'BidderA,2026-04-02,500000,750,1.5\n';
    const args = bidderBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-02' },
      group_by: 'day',
    });
    const r = await bidderBreakdownTool.handler(args, {
      client: createMockGamClient({
        reports: [{
          query: {
            dimensions: ['BIDDER_NAME', 'DATE'],
            metrics: [
              'AD_EXCHANGE_IMPRESSIONS',
              'AD_EXCHANGE_REVENUE',
              'AD_EXCHANGE_AVERAGE_ECPM',
            ],
          },
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
