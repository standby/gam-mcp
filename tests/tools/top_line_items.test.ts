import { describe, it, expect } from 'vitest';
import { topLineItemsTool } from '../../src/tools/top_line_items.js';
import { makeCtx } from '../helpers.js';

describe('top_line_items', () => {
  it('queries line-item dims with order/advertiser context', async () => {
    const args = topLineItemsTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
      top_n: 5,
      metric: 'revenue',
    });
    const r = await topLineItemsTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: {
            dimensions: ['LINE_ITEM_ID', 'LINE_ITEM_NAME', 'ORDER_ID', 'ORDER_NAME', 'ADVERTISER_ID', 'ADVERTISER_NAME'],
            metrics: ['REVENUE'],
          },
          rows: [{
            LINE_ITEM_ID: 1, LINE_ITEM_NAME: 'LI1',
            ORDER_ID: 2, ORDER_NAME: 'Order1',
            ADVERTISER_ID: 3, ADVERTISER_NAME: 'Acme',
            REVENUE: 10000,
          }],
        }] },
        { timezone: 'America/Los_Angeles' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
  });
});
