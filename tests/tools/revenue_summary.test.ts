import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revenueSummaryTool } from '../../src/tools/revenue_summary.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

describe('revenue_summary', () => {
  it('groups by advertiser when group_by=advertiser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-'));
    const csv = 'advertiser_name,revenue,impressions\nAcme,5000,1000\n';
    const ctx = {
      client: createMockGamClient({
        reports: [{
          query: {
            dimensions: ['ADVERTISER_NAME'],
            metrics: ['REVENUE', 'IMPRESSIONS'],
          },
          csvGz: gzipSync(Buffer.from(csv)),
        }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
      now: new Date('2026-04-30T12:00:00Z'),
    };
    const r = await revenueSummaryTool.handler(
      { date_range: { start: '2026-04-01', end: '2026-04-29' }, group_by: 'advertiser' },
      ctx,
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
