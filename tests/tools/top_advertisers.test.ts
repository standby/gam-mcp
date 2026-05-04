import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topAdvertisersTool } from '../../src/tools/top_advertisers.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';

describe('top_advertisers', () => {
  it('queries advertiser dimension with chosen metric', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-'));
    const csv = 'advertiser_name,revenue\nAcme,9999\nBeta,500\n';
    const args = topAdvertisersTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
      top_n: 10,
      metric: 'revenue',
    });
    const r = await topAdvertisersTool.handler(
      args,
      {
        client: createMockGamClient({
          reports: [{
            query: { dimensions: ['ADVERTISER_NAME'], metrics: ['REVENUE'] },
            csvGz: gzipSync(Buffer.from(csv)),
          }],
        }),
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: 'America/Los_Angeles',
      },
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
