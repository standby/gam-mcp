import { describe, it, expect } from 'vitest';
import { inventoryBreakdownTool } from '../../src/tools/inventory_breakdown.js';
import { makeCtx } from '../helpers.js';

describe('inventory_breakdown', () => {
  it('queries by line_item_type', async () => {
    const args = inventoryBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
    });
    const r = await inventoryBreakdownTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: {
            dimensions: ['LINE_ITEM_TYPE'],
            metrics: ['TOTAL_LINE_ITEM_LEVEL_REVENUE', 'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS'],
          },
          rows: [
            { LINE_ITEM_TYPE: 'STANDARD', TOTAL_LINE_ITEM_LEVEL_REVENUE: 1000, TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS: 100 },
            { LINE_ITEM_TYPE: 'HOUSE', TOTAL_LINE_ITEM_LEVEL_REVENUE: 0, TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS: 50 },
          ],
        }] },
        { timezone: 'UTC' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(2);
  });
});
