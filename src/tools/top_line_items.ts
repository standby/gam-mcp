import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';

const METRIC_MAP = {
  revenue: 'REVENUE',
  impressions: 'IMPRESSIONS',
} as const;

const inputSchema = z.object({
  date_range: dateRangeInput(HISTORICAL_RANGE),
  top_n: z.number().int().min(1).max(1000).default(20)
    .describe('How many line items to return, 1-1000.'),
  metric: z.enum(['revenue', 'impressions']).default('revenue')
    .describe('What to rank by: revenue (in the network currency) or impressions.'),
  line_item_type: z.string().optional()
    .describe('Only line items of this GAM line item type, e.g. STANDARD or SPONSORSHIP.'),
}).strict();

export const topLineItemsTool = buildReportTool({
  name: 'top_line_items',
  description: 'Top N line items by revenue or impressions, with order and advertiser context. Optional line_item_type filter (STANDARD, SPONSORSHIP, etc.).',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: ['LINE_ITEM_ID', 'LINE_ITEM_NAME', 'ORDER_ID', 'ORDER_NAME', 'ADVERTISER_ID', 'ADVERTISER_NAME'],
    metrics: [METRIC_MAP[input.metric]],
    filters: input.line_item_type
      ? [{ field: 'LINE_ITEM_TYPE', op: '=', value: input.line_item_type }]
      : undefined,
  }),
  summary: (input, range) =>
    `Top line items by ${input.metric}, ${range.start}..${range.end}` +
    (input.line_item_type ? ` (type=${input.line_item_type})` : ''),
  topN: (input) => input.top_n,
  sort: (input) => ({ metric: METRIC_MAP[input.metric], descending: true }),
});
