import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';
import type { ReportQuery } from '../gam-client.js';

const METRIC_MAP = {
  revenue: 'REVENUE',
  impressions: 'IMPRESSIONS',
} as const;

const inputSchema = z.object({
  // The MCP pins this to slot 0 internally; a single call breaks down one key.
  custom_targeting_key_id: z.number().int().positive()
    .describe('The custom targeting key to break down. Find its ID with lookup(entity_type="custom_targeting_key").'),
  date_range: dateRangeInput(HISTORICAL_RANGE),
  metric: z.enum(['revenue', 'impressions']).default('revenue')
    .describe('What to rank values by: revenue (in the network currency) or impressions.'),
  top_n: z.number().int().min(1).max(1000).default(20)
    .describe('How many values to return, 1-1000.'),
  // Entity narrowing. Combining them is allowed; the filters are ANDed.
  ad_unit_id: z.number().int().positive().optional()
    .describe('Only this ad unit. Combined with the other narrowing fields by AND.'),
  order_id: z.number().int().positive().optional()
    .describe('Only this order. Combined with the other narrowing fields by AND.'),
  line_item_id: z.number().int().positive().optional()
    .describe('Only this line item. Combined with the other narrowing fields by AND.'),
}).strict();

type Input = z.infer<typeof inputSchema>;

function buildFilters(input: Input): ReportQuery['filters'] {
  const filters: NonNullable<ReportQuery['filters']> = [];
  if (input.ad_unit_id !== undefined) {
    filters.push({ field: 'AD_UNIT_ID', op: '=', value: input.ad_unit_id });
  }
  if (input.order_id !== undefined) {
    filters.push({ field: 'ORDER_ID', op: '=', value: input.order_id });
  }
  if (input.line_item_id !== undefined) {
    filters.push({ field: 'LINE_ITEM_ID', op: '=', value: input.line_item_id });
  }
  return filters.length ? filters : undefined;
}

function scopeLabel(input: Input): string {
  const parts: string[] = [];
  if (input.ad_unit_id !== undefined) parts.push(`ad_unit=${input.ad_unit_id}`);
  if (input.order_id !== undefined) parts.push(`order=${input.order_id}`);
  if (input.line_item_id !== undefined) parts.push(`line_item=${input.line_item_id}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

export const kvBreakdownTool = buildReportTool({
  name: 'kv_breakdown',
  description:
    "Top values of a publisher custom-targeting key by revenue or impressions over a date range, with optional narrowing to one ad unit / order / line item. Use this for 'top content categories', 'top tiers', etc. Requires a custom_targeting_key_id — discover it via lookup(entity_type=\"custom_targeting_key\"). Rows aggregate cleanly (each request emits one value per key), unlike KEY_VALUES_NAME which double-counts when a request matches multiple KV pairs.",
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: ['CUSTOM_DIMENSION_0_VALUE'],
    metrics: [METRIC_MAP[input.metric]],
    filters: buildFilters(input),
    custom_dimension_key_ids: [input.custom_targeting_key_id],
  }),
  summary: (input, range) =>
    `Top values of custom_targeting_key=${input.custom_targeting_key_id} by ${input.metric}, ` +
    `${range.start}..${range.end}${scopeLabel(input)}`,
  topN: (input) => input.top_n,
  sort: (input) => ({ metric: METRIC_MAP[input.metric], descending: true }),
});
