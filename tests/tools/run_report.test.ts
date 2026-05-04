import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReportTool } from '../../src/tools/run_report.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-'));
  const csv = 'advertiser_name,revenue\nAcme,1000\n';
  return {
    dir,
    ctx: {
      client: createMockGamClient({
        reports: [{
          query: { dimensions: ['ADVERTISER_NAME'], metrics: ['REVENUE'] },
          csvGz: gzipSync(Buffer.from(csv)),
        }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      now: new Date('2026-04-30T12:00:00Z'),
    },
  };
};

describe('run_report', () => {
  it('runs a valid query', async () => {
    const { ctx, dir } = setup();
    const r = await runReportTool.handler(
      {
        dimensions: ['ADVERTISER_NAME'],
        metrics: ['REVENUE'],
        date_range: { relative: 'last_7_days' as const },
      },
      ctx,
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unknown dimension', async () => {
    const { ctx, dir } = setup();
    const r = await runReportTool.handler(
      {
        dimensions: ['NOT_A_DIMENSION'],
        metrics: ['REVENUE'],
        date_range: { relative: 'yesterday' as const },
      },
      ctx,
    );
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect((r.error as { code: string }).code).toBe('INVALID_INPUT');
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
