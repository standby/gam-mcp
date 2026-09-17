import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';

const inputSchema = z.object({
  date_range: z.object({ start: z.string(), end: z.string() }),
  group_by: z.enum(['line_item_type', 'advertiser', 'order']).default('line_item_type'),
});

const DIM = {
  line_item_type: 'LINE_ITEM_TYPE',
  advertiser: 'ADVERTISER_NAME',
  order: 'ORDER_NAME',
} as const;

export const inventoryBreakdownTool = buildReportTool({
  name: 'inventory_breakdown',
  description:
    'Revenue and impressions broken down by line_item_type (programmatic vs. direct vs. house mix), or by advertiser/order.',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: [DIM[input.group_by]],
    metrics: ['REVENUE', 'IMPRESSIONS'],
  }),
  summary: (input) =>
    `Inventory breakdown by ${input.group_by}, ${input.date_range.start}..${input.date_range.end}`,
});
