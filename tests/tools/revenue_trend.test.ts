import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revenueTrendTool } from '../../src/tools/revenue_trend.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';

describe('revenue_trend', () => {
  it('returns daily series', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'));
    const csv = 'date,revenue,impressions\n2026-04-01,100,1000\n2026-04-02,150,1500\n';
    const args = revenueTrendTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
      granularity: 'day',
    });
    const r = await revenueTrendTool.handler(
      args,
      {
        client: createMockGamClient({
          reports: [{
            query: {
              dimensions: ['DATE'],
              metrics: ['REVENUE', 'IMPRESSIONS'],
            },
            csvGz: gzipSync(Buffer.from(csv)),
          }],
        }),
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: 'UTC',
      },
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
