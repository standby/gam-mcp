import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAnomaliesTool } from '../../src/tools/find_anomalies.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';

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
});
