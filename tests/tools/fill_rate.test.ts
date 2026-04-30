import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillRateTool } from '../../src/tools/fill_rate.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';

describe('fill_rate', () => {
  it('reports fill rate grouped by ad_unit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-'));
    const csv = 'ad_unit_name,total_ad_requests,total_unfilled_impressions,total_line_item_level_fill_rate\n/home,1000,100,0.9\n';
    const r = await fillRateTool.handler(
      { date_range: { start: '2026-04-01', end: '2026-04-29' }, group_by: 'ad_unit' },
      {
        client: createMockGamClient({
          reports: [{
            query: {
              dimensions: ['AD_UNIT_NAME'],
              metrics: ['TOTAL_AD_REQUESTS', 'TOTAL_UNFILLED_IMPRESSIONS', 'TOTAL_LINE_ITEM_LEVEL_FILL_RATE'],
            },
            csvGz: gzipSync(Buffer.from(csv)),
          }],
        }),
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: 'America/Los_Angeles',
      },
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
