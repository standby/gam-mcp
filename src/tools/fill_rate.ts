import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';

const GROUP_BY = {
  ad_unit:         'AD_UNIT_NAME',
  device_category: 'DEVICE_CATEGORY_NAME',
  country:         'COUNTRY_NAME',
  day:             'DATE',
} as const;

const inputSchema = z.object({
  date_range: dateRangeInput(HISTORICAL_RANGE),
  group_by: z.enum(Object.keys(GROUP_BY) as [keyof typeof GROUP_BY, ...(keyof typeof GROUP_BY)[]])
    .describe('One row per ad unit, device category, country, or day.'),
}).strict();

export const fillRateTool = buildReportTool({
  name: 'fill_rate',
  description: 'Fill rate, ad requests, and unfilled impressions grouped by ad_unit, device_category, country, or day.',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: [GROUP_BY[input.group_by]],
    metrics: [
      'AD_REQUESTS',
      'UNFILLED_IMPRESSIONS',
      'FILL_RATE',
    ],
  }),
  summary: (input, range) =>
    `Fill rate by ${input.group_by}, ${range.start}..${range.end}`,
});
