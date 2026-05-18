import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

const SECONDARY = {
  none: null,
  day: 'DATE',
  ad_unit: 'AD_UNIT_NAME',
  country: 'COUNTRY_NAME',
  device: 'DEVICE_CATEGORY_NAME',
  line_item_type: 'LINE_ITEM_TYPE',
} as const;

const inputSchema = z.object({
  date_range: z.object({ start: z.string(), end: z.string() }),
  group_by: z
    .enum(['none', 'day', 'ad_unit', 'country', 'device', 'line_item_type'])
    .default('none'),
  top_n: z.number().int().min(1).max(500).default(50),
});

export const bidderBreakdownTool = buildReportTool({
  name: 'bidder_breakdown',
  description:
    "Open Bidding (EBDA) yield by bidder. Returns impressions, revenue, and average eCPM per BIDDER_NAME over a date range, " +
    "using Ad Exchange (programmatic-only) metrics so direct-sold revenue doesn't pollute the comparison. " +
    "group_by adds a secondary slice (day | ad_unit | country | device | line_item_type) when you need to see *where* a bidder is winning. " +
    "Rows with an empty BIDDER_NAME represent programmatic impressions that didn't go through a named Open Bidding bidder " +
    "(open-auction AdX, AdSense backfill) — keep them as the share-of-programmatic baseline.",
  input: inputSchema,
  buildQuery: (input): ReportQuery => {
    const secondary = SECONDARY[input.group_by];
    return {
      dimensions: secondary ? ['BIDDER_NAME', secondary] : ['BIDDER_NAME'],
      metrics: [
        'AD_EXCHANGE_IMPRESSIONS',
        'AD_EXCHANGE_REVENUE',
        'AD_EXCHANGE_AVERAGE_ECPM',
      ],
    };
  },
  summary: (input) => {
    const slice = input.group_by === 'none' ? '' : ` x ${input.group_by}`;
    return `Open Bidding breakdown by bidder${slice}, ${input.date_range.start}..${input.date_range.end} (top ${input.top_n})`;
  },
});
