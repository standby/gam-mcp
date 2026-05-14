import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryBreakdownTool } from '../../src/tools/inventory_breakdown.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

describe('inventory_breakdown', () => {
  it('queries by line_item_type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ib-'));
    const csv = 'line_item_type,total_line_item_level_revenue,total_line_item_level_impressions\nSTANDARD,1000,100\nHOUSE,0,50\n';
    const args = inventoryBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
    });
    const r = await inventoryBreakdownTool.handler(
      args,
      {
        client: createMockGamClient({
          reports: [{
            query: {
              dimensions: ['LINE_ITEM_TYPE'],
              metrics: ['TOTAL_LINE_ITEM_LEVEL_REVENUE', 'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'],
            },
            csvGz: gzipSync(Buffer.from(csv)),
          }],
        }),
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: 'UTC',
        logger: noopLogger(),
      },
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
