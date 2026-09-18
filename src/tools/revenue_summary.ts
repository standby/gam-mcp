import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';

const GROUP_BY = {
  day: ['DATE'],
  week: ['WEEK'],
  month: ['MONTH_YEAR'],
  advertiser: ['ADVERTISER_ID', 'ADVERTISER_NAME'],
  order: ['ORDER_ID', 'ORDER_NAME'],
  line_item: ['LINE_ITEM_ID', 'LINE_ITEM_NAME'],
  ad_unit: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
  country: ['COUNTRY_NAME'],
  device_category: ['DEVICE_CATEGORY_NAME'],
  line_item_type: ['LINE_ITEM_TYPE'],
} as const;

const inputSchema = z.object({
  date_range: dateRangeInput(HISTORICAL_RANGE),
  group_by: z.enum(Object.keys(GROUP_BY) as [keyof typeof GROUP_BY, ...(keyof typeof GROUP_BY)[]]).optional()
    .describe('Split the totals into one row per value of this dimension. Omit it for a single total row.'),
}).strict();

export const revenueSummaryTool = buildReportTool({
  name: 'revenue_summary',
  description:
    'Total revenue and impressions for a date range, optionally grouped by day/week/month/advertiser/order/line_item/ad_unit/country/device_category/line_item_type.',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: input.group_by ? [...GROUP_BY[input.group_by]] : [],
    metrics: ['REVENUE', 'IMPRESSIONS'],
  }),
  summary: (input, range) =>
    `Revenue summary ${range.start}..${range.end}` +
    (input.group_by ? ` grouped by ${input.group_by}` : ''),
});
