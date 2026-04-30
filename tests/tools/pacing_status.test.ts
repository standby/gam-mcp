import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pacingStatusTool } from '../../src/tools/pacing_status.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';

describe('pacing_status', () => {
  it('returns pacing rows for currently-flighting line items', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-'));
    const csv = 'line_item_name,line_item_id,line_item_progress,line_item_lifetime_impressions_delivered,line_item_goal_quantity\nLI1,123,0.78,7800,10000\n';
    const r = await pacingStatusTool.handler(
      {},
      {
        client: createMockGamClient({
          reports: [{
            query: {
              dimensions: ['LINE_ITEM_NAME', 'LINE_ITEM_ID'],
              metrics: ['LINE_ITEM_PROGRESS', 'LINE_ITEM_LIFETIME_IMPRESSIONS_DELIVERED', 'LINE_ITEM_GOAL_QUANTITY'],
            },
            csvGz: gzipSync(Buffer.from(csv)),
          }],
        }),
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: 'America/Los_Angeles',
        now: new Date('2026-04-30T12:00:00Z'),
      },
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
