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
    .describe('How many advertisers to return, 1-1000.'),
  metric: z.enum(['revenue', 'impressions']).default('revenue')
    .describe('What to rank by: revenue (in the network currency) or impressions.'),
}).strict();

export const topAdvertisersTool = buildReportTool({
  name: 'top_advertisers',
  description: 'Top N advertisers by revenue or impressions over a date range.',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: ['ADVERTISER_NAME'],
    metrics: [METRIC_MAP[input.metric]],
  }),
  summary: (input, range) =>
    `Top advertisers by ${input.metric}, ${range.start}..${range.end}`,
  topN: (input) => input.top_n,
  sort: (input) => ({ metric: METRIC_MAP[input.metric], descending: true }),
});
