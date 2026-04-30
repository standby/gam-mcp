import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';

const METRIC_MAP = {
  revenue: 'TOTAL_LINE_ITEM_LEVEL_REVENUE',
  impressions: 'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',
} as const;

const inputSchema = z.object({
  date_range: z.object({ start: z.string(), end: z.string() }),
  top_n: z.number().int().min(1).max(1000).default(20),
  metric: z.enum(['revenue', 'impressions']).default('revenue'),
});

export const topAdvertisersTool = buildReportTool({
  name: 'top_advertisers',
  description: 'Top N advertisers by revenue or impressions over a date range.',
  input: inputSchema,
  buildQuery: (input) => ({
    dimensions: ['ADVERTISER_NAME'],
    metrics: [METRIC_MAP[input.metric]],
  }),
  summary: (input) =>
    `Top ${input.top_n} advertisers by ${input.metric}, ${input.date_range.start}..${input.date_range.end}`,
});
