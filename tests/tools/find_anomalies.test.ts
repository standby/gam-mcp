import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAnomaliesTool } from '../../src/tools/find_anomalies.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

function csv(header: string[], rows: (string | number)[][]): Buffer {
  const lines = [header.join(','), ...rows.map((r) => r.join(','))];
  return gzipSync(Buffer.from(lines.join('\n') + '\n'));
}

function ctx(opts: { fixtures: any[]; now: Date }) {
  const dir = mkdtempSync(join(tmpdir(), 'fa-'));
  return {
    dir,
    ctx: {
      client: createMockGamClient({ reports: opts.fixtures }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
      now: opts.now,
    },
  };
}

describe('find_anomalies', () => {
  it('pacing_underdelivery flags line items below pro-rated pace and ranks by shortfall', async () => {
    // mid-month: now = 2026-04-15 → expected progress = 15/30 = 50%
    const now = new Date('2026-04-15T12:00:00Z');
    const { ctx: c, dir } = ctx({
      now,
      fixtures: [
        {
          query: {
            dimensions: ['LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE', 'LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE'],
            metrics: ['IMPRESSIONS'],
          },
          csvGz: csv(
            ['LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE', 'LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE', 'IMPRESSIONS'],
            [
              // On track: 50% delivered at 50% expected
              ['1', 'OnTrack', 'STANDARD', 100000, 50000],
              // Under: 20% delivered → pacing 40% of expected (below default 80% threshold)
              ['2', 'Under', 'STANDARD', 100000, 20000],
              // Way under: 10% delivered → pacing 20%
              ['3', 'WayUnder', 'SPONSORSHIP', 200000, 20000],
              // Tiny goal → filtered out (skip line items with goal < 1000)
              ['4', 'TinyGoal', 'STANDARD', 500, 0],
            ],
          ),
        },
      ],
    });

    const args = findAnomaliesTool.input.parse({ kind: 'pacing_underdelivery' });
    const r = await findAnomaliesTool.handler(args, c);
    expect('rows' in r).toBe(true);
    if (!('rows' in r)) return;

    // OnTrack and TinyGoal excluded; remaining sorted by shortfall (WayUnder first)
    expect(r.rows!.map((x) => x.LINE_ITEM_NAME)).toEqual(['WayUnder', 'Under']);
    expect(r.rows![0].pacing_pct).toBe('20.0');
    expect(r.rows![1].pacing_pct).toBe('40.0');
    expect(Number(r.rows![0].shortfall)).toBeGreaterThan(Number(r.rows![1].shortfall));

    rmSync(dir, { recursive: true, force: true });
  });

  it('ecpm_regression flags buyer networks whose AdX eCPM dropped WoW past threshold', async () => {
    // last_7_days at now=2026-04-15 → base [04-08..04-14], prev [04-01..04-07]
    const now = new Date('2026-04-15T12:00:00Z');
    const header = ['BUYER_NETWORK_NAME', 'AD_EXCHANGE_IMPRESSIONS', 'AD_EXCHANGE_REVENUE', 'AD_EXCHANGE_AVERAGE_ECPM'];
    const query = {
      dimensions: ['BUYER_NETWORK_NAME'],
      metrics: ['AD_EXCHANGE_IMPRESSIONS', 'AD_EXCHANGE_REVENUE', 'AD_EXCHANGE_AVERAGE_ECPM'],
    };
    const { ctx: c, dir } = ctx({
      now,
      fixtures: [
        // base (last 7 days) — DSP_A dropped to $1.00, DSP_B flat
        {
          query,
          dateRange: { start: '2026-04-08', end: '2026-04-14' },
          csvGz: csv(header, [
            ['DSP_A', 1_000_000, 1000, 1.0],   // eCPM fell from 2.0 → 1.0 (50% drop)
            ['DSP_B', 800_000, 1600, 2.0],     // flat
            ['DSP_LowVol', 500, 5, 10.0],      // < 10k imps → filtered as noise
          ]),
        },
        // prev (week before)
        {
          query,
          dateRange: { start: '2026-04-01', end: '2026-04-07' },
          csvGz: csv(header, [
            ['DSP_A', 1_200_000, 2400, 2.0],
            ['DSP_B', 900_000, 1800, 2.0],
            ['DSP_LowVol', 500, 5, 10.0],
          ]),
        },
      ],
    });

    const args = findAnomaliesTool.input.parse({ kind: 'ecpm_regression' });
    const r = await findAnomaliesTool.handler(args, c);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));

    expect(r.rows!.map((x) => x.BUYER_NETWORK_NAME)).toEqual(['DSP_A']);
    expect(r.rows![0].ecpm_now).toBe('1.00');
    expect(r.rows![0].ecpm_prev).toBe('2.00');
    expect(Number(r.rows![0].drop_pct)).toBeCloseTo(50.0, 1);

    rmSync(dir, { recursive: true, force: true });
  });

  it('viewability_drops flags ad units whose viewable-impression rate fell WoW', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const header = ['AD_UNIT_ID', 'AD_UNIT_NAME', 'IMPRESSIONS', 'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE'];
    const query = {
      dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
      metrics: ['IMPRESSIONS', 'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE'],
    };
    const { ctx: c, dir } = ctx({
      now,
      fixtures: [
        {
          query,
          dateRange: { start: '2026-04-08', end: '2026-04-14' },
          csvGz: csv(header, [
            // rate is 0..1 fraction in GAM; .60 = 60%
            ['100', 'TopBanner', 500_000, 0.60],   // dropped 20pp from 80% → 60%
            ['200', 'Sidebar',   500_000, 0.75],   // flat
            ['300', 'LowVol',    1000,    0.40],   // < 10k imps → filtered
          ]),
        },
        {
          query,
          dateRange: { start: '2026-04-01', end: '2026-04-07' },
          csvGz: csv(header, [
            ['100', 'TopBanner', 600_000, 0.80],
            ['200', 'Sidebar',   600_000, 0.75],
            ['300', 'LowVol',    1000,    0.80],
          ]),
        },
      ],
    });

    const args = findAnomaliesTool.input.parse({ kind: 'viewability_drops' });
    const r = await findAnomaliesTool.handler(args, c);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));

    expect(r.rows!.map((x) => x.AD_UNIT_NAME)).toEqual(['TopBanner']);
    expect(r.rows![0].viewability_now_pct).toBe('60.00');
    expect(r.rows![0].viewability_prev_pct).toBe('80.00');
    expect(Number(r.rows![0].drop_pp)).toBeCloseTo(20.0, 1);

    rmSync(dir, { recursive: true, force: true });
  });
});
