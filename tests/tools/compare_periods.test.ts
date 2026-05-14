import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comparePeriodsTool } from '../../src/tools/compare_periods.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

function csv(header: string[], rows: (string | number)[][]): Buffer {
  const lines = [header.join(','), ...rows.map((r) => r.join(','))];
  return gzipSync(Buffer.from(lines.join('\n') + '\n'));
}

function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'cmp-'));
  return {
    dir,
    ctx: {
      client: createMockGamClient({
        reports: [
          // BASE period (last 7 days)
          {
            query: { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] },
            dateRange: { start: '2026-04-23', end: '2026-04-29' },
            csvGz: csv(['ADVERTISER_NAME', 'IMPRESSIONS'], [
              ['Acme', 1000],
              ['Beta', 200],
              ['NewCo', 50],
            ]),
          },
          // PREV period (previous_period -> 2026-04-16..22)
          {
            query: { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] },
            dateRange: { start: '2026-04-16', end: '2026-04-22' },
            csvGz: csv(['ADVERTISER_NAME', 'IMPRESSIONS'], [
              ['Acme', 800],
              ['Beta', 250],
              ['Gone', 99],
            ]),
          },
        ],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    },
  };
}

describe('compare_periods', () => {
  it('joins base and previous_period rows, emits delta_pct, includes one-sided rows', async () => {
    const { ctx: c, dir } = ctx();
    const args = comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_NAME'],
      metrics: ['IMPRESSIONS'],
      base_range: { start: '2026-04-23', end: '2026-04-29' },
      comparison: 'previous_period',
    });
    const r = await comparePeriodsTool.handler(args, c);
    expect('rows' in r).toBe(true);
    if (!('rows' in r)) return;
    const byAdv = Object.fromEntries(r.rows!.map((row) => [row.ADVERTISER_NAME, row]));

    expect(byAdv.Acme.IMPRESSIONS).toBe('1000');
    expect(byAdv.Acme.IMPRESSIONS_prev).toBe('800');
    expect(byAdv.Acme.IMPRESSIONS_delta_pct).toBe('25.00');

    expect(byAdv.Beta.IMPRESSIONS).toBe('200');
    expect(byAdv.Beta.IMPRESSIONS_prev).toBe('250');
    expect(byAdv.Beta.IMPRESSIONS_delta_pct).toBe('-20.00');

    // NewCo only in base — prev is null, delta_pct empty
    expect(byAdv.NewCo.IMPRESSIONS).toBe('50');
    expect(byAdv.NewCo.IMPRESSIONS_prev).toBe('');
    expect(byAdv.NewCo.IMPRESSIONS_delta_pct).toBe('');

    // Gone only in prev — base is null
    expect(byAdv.Gone.IMPRESSIONS).toBe('');
    expect(byAdv.Gone.IMPRESSIONS_prev).toBe('99');
    expect(byAdv.Gone.IMPRESSIONS_delta_pct).toBe('');

    // Sorted by primary metric (IMPRESSIONS) descending — Acme first
    expect(r.rows![0].ADVERTISER_NAME).toBe('Acme');

    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unknown metrics with an actionable hint', async () => {
    const { ctx: c, dir } = ctx();
    const args = comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_NAME'],
      metrics: ['NOT_A_METRIC'],
      base_range: { start: '2026-04-23', end: '2026-04-29' },
      comparison: 'previous_period',
    });
    const r = await comparePeriodsTool.handler(args, c);
    expect('error' in r).toBe(true);
    if ('error' in r) expect((r.error as { code: string }).code).toBe('INVALID_INPUT');
    rmSync(dir, { recursive: true, force: true });
  });
});
