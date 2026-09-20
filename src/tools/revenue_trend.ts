import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';

const SPLIT = {
  advertiser: ['ADVERTISER_ID', 'ADVERTISER_NAME'],
  order: ['ORDER_ID', 'ORDER_NAME'],
  line_item_type: ['LINE_ITEM_TYPE'],
  ad_unit: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
  country: ['COUNTRY_NAME'],
  device_category: ['DEVICE_CATEGORY_NAME'],
} as const;

const inputSchema = z.object({
  date_range: dateRangeInput(HISTORICAL_RANGE),
  granularity: z.enum(['day', 'week']).default('day')
    .describe('One point per day or per week.'),
  split_by: z.enum(Object.keys(SPLIT) as [keyof typeof SPLIT, ...(keyof typeof SPLIT)[]]).optional()
    .describe('Also split each point by this dimension. Omit it for one series.'),
}).strict();

export const revenueTrendTool = buildReportTool({
  name: 'revenue_trend',
  description:
    'Time series of revenue and impressions at day or week granularity, optionally split by one dimension.',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: [
      input.granularity === 'week' ? 'WEEK' : 'DATE',
      ...(input.split_by ? SPLIT[input.split_by] : []),
    ],
    metrics: ['REVENUE', 'IMPRESSIONS'],
  }),
  summary: (input, range) =>
    `Revenue trend (${input.granularity}) ${range.start}..${range.end}` +
    (input.split_by ? ` split by ${input.split_by}` : ''),
});
