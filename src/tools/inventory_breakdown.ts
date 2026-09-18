import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';

const inputSchema = z.object({
  date_range: dateRangeInput(HISTORICAL_RANGE),
  group_by: z.enum(['line_item_type', 'advertiser', 'order']).default('line_item_type')
    .describe("Split revenue and impressions by line item type (the demand mix), advertiser, or order."),
}).strict();

const DIM = {
  line_item_type: ['LINE_ITEM_TYPE'],
  advertiser: ['ADVERTISER_ID', 'ADVERTISER_NAME'],
  order: ['ORDER_ID', 'ORDER_NAME'],
} as const;

export const inventoryBreakdownTool = buildReportTool({
  name: 'inventory_breakdown',
  description:
    'Revenue and impressions broken down by line_item_type (programmatic vs. direct vs. house mix), or by advertiser/order.',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: [...DIM[input.group_by]],
    metrics: ['REVENUE', 'IMPRESSIONS'],
  }),
  summary: (input, range) =>
    `Inventory breakdown by ${input.group_by}, ${range.start}..${range.end}`,
});
