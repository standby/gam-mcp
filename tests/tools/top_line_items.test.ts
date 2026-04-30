import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topLineItemsTool } from '../../src/tools/top_line_items.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';

describe('top_line_items', () => {
  it('queries line-item dims with order/advertiser context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tli-'));
    const csv = 'line_item_name,order_name,advertiser_name,total_line_item_level_revenue\nLI1,Order1,Acme,10000\n';
    const args = topLineItemsTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
      top_n: 5,
      metric: 'revenue',
    });
    const r = await topLineItemsTool.handler(
      args,
      {
        client: createMockGamClient({
          reports: [{
            query: {
              dimensions: ['LINE_ITEM_NAME', 'ORDER_NAME', 'ADVERTISER_NAME'],
              metrics: ['TOTAL_LINE_ITEM_LEVEL_REVENUE'],
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
