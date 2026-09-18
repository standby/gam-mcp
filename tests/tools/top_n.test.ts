import { describe, it, expect } from 'vitest';
import { createFakeGam, dbl, int, str } from '../fake-gam.js';
import { restCtx } from '../helpers.js';
import type { ToolDefinition } from '../../src/report-tool-builder.js';
import { topAdvertisersTool } from '../../src/tools/top_advertisers.js';
import { topLineItemsTool } from '../../src/tools/top_line_items.js';
import { kvBreakdownTool } from '../../src/tools/kv_breakdown.js';
import { bidderBreakdownTool } from '../../src/tools/bidder_breakdown.js';
import { yieldBreakdownTool } from '../../src/tools/yield_breakdown.js';
import { videoBreakdownTool } from '../../src/tools/video_breakdown.js';
import { viewabilityBreakdownTool } from '../../src/tools/viewability_breakdown.js';

// A fixture of 5 rows in deliberately ascending revenue order: if the tool
// returned fixture order rather than GAM's sorted order the assertion on the
// captured definition would still pass, so the definition is what we assert.
function world(rows = 5) {
  const gam = createFakeGam();
  gam.setRows({
    byColumn: Array.from({ length: rows }, (_, i) => ({
      ADVERTISER_ID: int(4000000 + i),
      ADVERTISER_NAME: str(`Advertiser ${i}`),
      REVENUE: dbl(i * 100),
    })),
  });
  return { gam, ctx: restCtx(gam) };
}

// The brief's handler calls skip input.parse and so skip its date_range
// default (there is none — every report tool requires one). Every call below
// adds one explicitly; it is otherwise unexamined by these assertions.
const DATE_RANGE = { start: '2026-09-01', end: '2026-09-16' };

describe('I1: top_n sorts in the definition and caps the rows', () => {
  it('puts a descending sort on the tool metric into the definition', async () => {
    const { gam, ctx } = world();
    await topAdvertisersTool.handler({ date_range: DATE_RANGE, top_n: 3, metric: 'revenue' } as never, ctx);
    const def = gam.lastDefinition();
    expect(def.sorts).toEqual([{ field: { metric: 'REVENUE' }, descending: true }]);
  });

  // One case per top_n tool: its own fixture dimension, expected sort metric,
  // and a top_n + 2 row fixture, so every tool is checked for the same five
  // things — the definition's sorts, the row cap, and the summary clause.
  const TOP_N = 3;
  const ROWS = TOP_N + 2;

  type Case = {
    name: string;
    tool: ToolDefinition<never>;
    args: Record<string, unknown>;
    dimension: string;
    metric: string;
  };

  // Calling .handler() directly (as the brief's fixture does) skips zod, so
  // every field a tool's buildQuery reads without its own fallback -- by,
  // group_by -- is given explicitly here rather than relying on a schema
  // default that never runs.
  const CASES: Case[] = [
    { name: 'top_advertisers', tool: topAdvertisersTool, args: { metric: 'revenue' }, dimension: 'ADVERTISER_NAME', metric: 'REVENUE' },
    { name: 'top_line_items', tool: topLineItemsTool, args: { metric: 'revenue' }, dimension: 'LINE_ITEM_NAME', metric: 'REVENUE' },
    { name: 'kv_breakdown', tool: kvBreakdownTool, args: { custom_targeting_key_id: 555, metric: 'revenue' }, dimension: 'CUSTOM_DIMENSION_0_VALUE', metric: 'REVENUE' },
    { name: 'bidder_breakdown', tool: bidderBreakdownTool, args: { group_by: 'none' }, dimension: 'BIDDER_NAME', metric: 'AD_EXCHANGE_REVENUE' },
    { name: 'yield_breakdown', tool: yieldBreakdownTool, args: { by: 'buyer', group_by: 'none' }, dimension: 'YIELD_GROUP_BUYER_NAME', metric: 'YIELD_GROUP_ESTIMATED_REVENUE' },
    { name: 'video_breakdown', tool: videoBreakdownTool, args: { by: 'ad_unit', group_by: 'none' }, dimension: 'AD_UNIT_NAME', metric: 'VIDEO_VIEWERSHIP_STARTS' },
    { name: 'viewability_breakdown', tool: viewabilityBreakdownTool, args: { by: 'ad_unit', group_by: 'none' }, dimension: 'AD_UNIT_NAME', metric: 'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS' },
  ];

  // Revenue/CPM-shaped metrics arrive as GAM currency doubles; count-shaped
  // ones (impressions, starts) as GAM int64 strings. Either fixture type
  // exercises the cap the same way; this just keeps the fixture plausible.
  const metricValue = (metric: string, i: number) =>
    /REVENUE|CPM/.test(metric) ? dbl(i * 100) : int(i * 100);

  it.each(CASES)('$name: caps rows and sorts by the tool metric', async ({ tool, args, dimension, metric }) => {
    const gam = createFakeGam();
    gam.setRows({
      byColumn: Array.from({ length: ROWS }, (_, i) => ({
        [dimension]: str(`Row ${i}`),
        [metric]: metricValue(metric, i),
      })),
    });
    const ctx = restCtx(gam);
    const r = await tool.handler({ date_range: DATE_RANGE, top_n: TOP_N, ...args } as never, ctx) as Record<string, any>;

    expect(r.error).toBeUndefined();
    const def = gam.lastDefinition();
    expect(def.sorts).toEqual([{ field: { metric }, descending: true }]);
    expect(r.returned_row_count).toBe(TOP_N);
    expect(r.total_row_count).toBe(ROWS);
    // §1.1 line 123: a top_n result is NOT truncated and carries no cursor.
    expect(r.truncated).toBe(false);
    expect(r.next_cursor).toBeNull();
    expect(r.summary).toMatch(/\(\d+ of \d+, sorted by [A-Z_]+ desc\)/);
    expect(r.provenance.sort).toEqual([{ field: { metric }, descending: true }]);
  });
});
