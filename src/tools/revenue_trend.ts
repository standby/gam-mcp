import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';

const SPLIT = {
  advertiser: 'ADVERTISER_NAME',
  order: 'ORDER_NAME',
  line_item_type: 'LINE_ITEM_TYPE',
  ad_unit: 'AD_UNIT_NAME',
  country: 'COUNTRY_NAME',
  device_category: 'DEVICE_CATEGORY_NAME',
} as const;

const inputSchema = z.object({
  date_range: z.object({ start: z.string(), end: z.string() }),
  granularity: z.enum(['day', 'week']).default('day'),
  split_by: z.enum(Object.keys(SPLIT) as [keyof typeof SPLIT, ...(keyof typeof SPLIT)[]]).optional(),
});

export const revenueTrendTool = buildReportTool({
  name: 'revenue_trend',
  description:
    'Time series of revenue and impressions at day or week granularity, optionally split by one dimension.',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: [
      input.granularity === 'week' ? 'WEEK' : 'DATE',
      ...(input.split_by ? [SPLIT[input.split_by]] : []),
    ],
    metrics: ['REVENUE', 'IMPRESSIONS'],
  }),
  summary: (input) =>
    `Revenue trend (${input.granularity}) ${input.date_range.start}..${input.date_range.end}` +
    (input.split_by ? ` split by ${input.split_by}` : ''),
});
