import { describe, it, expect } from 'vitest';
import { topLineItemsTool } from '../../src/tools/top_line_items.js';
import { createFakeGam, dbl, str } from '../fake-gam.js';
import { makeCtx, restCtx } from '../helpers.js';

describe('top_line_items', () => {
  // Task 1 gave top_n tools a "(N of M, sorted by METRIC desc)" clause; this
  // tool used to also append its own "(type=...)" ahead of it, so a filtered,
  // capped result read as two parentheticals back to back. The generic filter
  // clause (spec §4.7) now covers line_item_type too, and they join as one.
  it('line_item_type reads in the same parenthetical as the top_n/sort clause, not a second one', async () => {
    const gam = createFakeGam();
    gam.setRows({
      byColumn: Array.from({ length: 3 }, (_, i) => ({
        LINE_ITEM_ID: 1, LINE_ITEM_NAME: str(`LI${i}`),
        ORDER_ID: 2, ORDER_NAME: str('Order1'),
        ADVERTISER_ID: 3, ADVERTISER_NAME: str('Acme'),
        REVENUE: dbl(i * 100),
      })),
    });
    const ctx = restCtx(gam);
    const r = await topLineItemsTool.handler({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
      top_n: 2,
      metric: 'revenue',
      line_item_type: 'STANDARD',
    } as never, ctx) as Record<string, any>;
    expect(r.error).toBeUndefined();
    expect(r.summary).toMatch(/^Top line items by revenue, .* \([^)]*\)$/);
    // Exactly one parenthetical, holding both clauses.
    expect(r.summary.match(/\(/g)?.length).toBe(1);
    expect(r.summary).toContain('filtered by LINE_ITEM_TYPE = STANDARD');
    expect(r.summary).toMatch(/sorted by REVENUE desc/);
  });

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
