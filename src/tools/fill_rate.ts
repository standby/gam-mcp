import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';

const GROUP_BY = {
  ad_unit:         'AD_UNIT_NAME',
  device_category: 'DEVICE_CATEGORY_NAME',
  country:         'COUNTRY_NAME',
  day:             'DATE',
} as const;

const inputSchema = z.object({
  date_range: z.object({ start: z.string(), end: z.string() }),
  group_by: z.enum(Object.keys(GROUP_BY) as [keyof typeof GROUP_BY, ...(keyof typeof GROUP_BY)[]]),
});

export const fillRateTool = buildReportTool({
  name: 'fill_rate',
  description: 'Fill rate, ad requests, and unfilled impressions grouped by ad_unit, device_category, country, or day.',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: [GROUP_BY[input.group_by]],
    metrics: [
      'TOTAL_AD_REQUESTS',
      'TOTAL_UNFILLED_IMPRESSIONS',
      'TOTAL_LINE_ITEM_LEVEL_FILL_RATE',
    ],
  }),
  summary: (input) =>
    `Fill rate by ${input.group_by}, ${input.date_range.start}..${input.date_range.end}`,
});
