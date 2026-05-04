import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';

const METRIC_MAP = {
  revenue: 'REVENUE',
  impressions: 'IMPRESSIONS',
} as const;

const inputSchema = z.object({
  date_range: z.object({ start: z.string(), end: z.string() }),
  top_n: z.number().int().min(1).max(1000).default(20),
  metric: z.enum(['revenue', 'impressions']).default('revenue'),
  line_item_type: z.string().optional(),
});

export const topLineItemsTool = buildReportTool({
  name: 'top_line_items',
  description: 'Top N line items by revenue or impressions, with order and advertiser context. Optional line_item_type filter (STANDARD, SPONSORSHIP, etc.).',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: ['LINE_ITEM_NAME', 'ORDER_NAME', 'ADVERTISER_NAME'],
    metrics: [METRIC_MAP[input.metric]],
    filters: input.line_item_type
      ? [{ field: 'LINE_ITEM_TYPE', op: '=', value: input.line_item_type }]
      : undefined,
  }),
  summary: (input) =>
    `Top ${input.top_n} line items by ${input.metric}, ${input.date_range.start}..${input.date_range.end}` +
    (input.line_item_type ? ` (type=${input.line_item_type})` : ''),
});
