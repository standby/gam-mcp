import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';
import type { ReportQuery } from '../gam-client.js';

// Primary breakdown dimension: the Open Bidding partner (buyer) vs the
// configured yield group itself.
const PRIMARY = {
  buyer: ['YIELD_GROUP_BUYER_NAME'],
  yield_group: ['YIELD_GROUP_NAME'],
} as const;

// Optional secondary slice — same set as bidder_breakdown so the two read
// alike (see *where* a partner wins).
const SECONDARY = {
  none: null,
  day: ['DATE'],
  ad_unit: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
  country: ['COUNTRY_NAME'],
  device: ['DEVICE_CATEGORY_NAME'],
} as const;

const inputSchema = z.object({
  date_range: dateRangeInput(HISTORICAL_RANGE),
  by: z
    .enum(['buyer', 'yield_group'])
    .default('buyer')
    .describe("Primary breakdown: 'buyer' (Open Bidding partner) or 'yield_group' (the configured group)."),
  group_by: z
    .enum(['none', 'day', 'ad_unit', 'country', 'device'])
    .default('none')
    .describe('Optional secondary slice to see where yield comes from.'),
  top_n: z.number().int().min(1).max(500).default(50)
    .describe('Maximum rows to surface.'),
}).strict();

export const yieldBreakdownTool = buildReportTool({
  name: 'yield_breakdown',
  description:
    "Yield-management view of Open Bidding / mediation (yield groups). Returns impressions, estimated revenue, estimated eCPM, " +
    "mediation fill rate, and passbacks per partner (YIELD_GROUP_BUYER_NAME) or per yield group (YIELD_GROUP_NAME) over a date range — " +
    "the report to rank Open Bidding partners and prune the waterfall. " +
    "by='buyer' (default) compares partners; by='yield_group' compares configured groups. " +
    "group_by adds a secondary slice (day | ad_unit | country | device) when you need to see *where* a partner wins. " +
    "High passbacks with low fill flags a partner that's called but rarely delivers. " +
    "Note: yield-group metrics are programmatic — they don't combine with ad-server-only or request-level metrics. " +
    "For the open-auction AdX side use bidder_breakdown; for the combined AdX + Open Bidding number use the AD_EXCHANGE_PLUS_YIELD_GROUP_* metrics via run_report.",
  input: inputSchema,
  buildQuery: (input): ReportQuery => {
    const primary = PRIMARY[input.by];
    const secondary = SECONDARY[input.group_by];
    return {
      dimensions: secondary ? [...primary, ...secondary] : [...primary],
      metrics: [
        'YIELD_GROUP_IMPRESSIONS',
        'YIELD_GROUP_ESTIMATED_REVENUE',
        'YIELD_GROUP_ESTIMATED_CPM',
        'YIELD_GROUP_MEDIATION_FILL_RATE',
        'YIELD_GROUP_MEDIATION_PASSBACKS',
      ],
    };
  },
  summary: (input, range) => {
    const slice = input.group_by === 'none' ? '' : ` x ${input.group_by}`;
    return `Yield group breakdown by ${input.by}${slice}, ${range.start}..${range.end}`;
  },
  topN: (input) => input.top_n,
  sort: () => ({ metric: 'YIELD_GROUP_ESTIMATED_REVENUE', descending: true }),
});
