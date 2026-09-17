import { describe, it, expect } from 'vitest';
import { inventoryBreakdownTool } from '../../src/tools/inventory_breakdown.js';
import { makeCtx, ok } from '../helpers.js';

describe('inventory_breakdown', () => {
  it('asks for the REST metric names REVENUE and IMPRESSIONS (spec §4.4)', async () => {
    const args = inventoryBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
    });
    const r = ok(await inventoryBreakdownTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: { dimensions: ['LINE_ITEM_TYPE'], metrics: ['REVENUE', 'IMPRESSIONS'] },
          rows: [
            { LINE_ITEM_TYPE: 'STANDARD', REVENUE: 1000.5, IMPRESSIONS: 100 },
            { LINE_ITEM_TYPE: 'HOUSE', REVENUE: 0, IMPRESSIONS: 50 },
          ],
        }] },
        { timezone: 'UTC' },
      ),
    ));
    expect(r.total_row_count).toBe(2);
    expect(r.provenance.metrics).toEqual(['REVENUE', 'IMPRESSIONS']);
    expect(r.rows[0]).toEqual({ LINE_ITEM_TYPE: 'STANDARD', REVENUE: 1000.5, IMPRESSIONS: 100 });
  });
});
