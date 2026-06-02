import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

// Primary breakdown dimension for viewability.
const PRIMARY = {
  ad_unit: 'AD_UNIT_NAME',
  size: 'RENDERED_CREATIVE_SIZE',
  device: 'DEVICE_CATEGORY_NAME',
} as const;

const SECONDARY = {
  none: null,
  day: 'DATE',
  country: 'COUNTRY_NAME',
  device: 'DEVICE_CATEGORY_NAME',
} as const;

const inputSchema = z.object({
  date_range: z.object({ start: z.string(), end: z.string() }),
  by: z
    .enum(['ad_unit', 'size', 'device'])
    .default('ad_unit')
    .describe("Primary slice: 'ad_unit', 'size', or 'device'."),
  group_by: z
    .enum(['none', 'day', 'country', 'device'])
    .default('none')
    .describe('Optional secondary slice.'),
  top_n: z.number().int().min(1).max(500).default(50)
    .describe('Maximum rows to surface.'),
});

export const viewabilityBreakdownTool = buildReportTool({
  name: 'viewability_breakdown',
  description:
    "Active View viewability by inventory. Returns viewable / measurable / eligible impressions plus viewable rate " +
    "(viewable ÷ measurable) and measurable rate (measurable ÷ eligible), broken down by ad unit, creative size, or device over a date range. " +
    "Viewability directly drives CPMs, so use this to spot low-viewability placements/sizes worth repositioning or sizing differently. " +
    "by selects the primary slice; group_by adds a secondary slice (day | country | device). " +
    "A low measurable rate (not just low viewable rate) points to a measurement/integration problem rather than placement.",
  input: inputSchema,
  buildQuery: (input): ReportQuery => {
    const primary = PRIMARY[input.by];
    const secondary = SECONDARY[input.group_by];
    // Guard against by:'device' + group_by:'device' emitting a duplicate dim.
    const useSecondary = secondary && secondary !== primary ? secondary : null;
    return {
      dimensions: useSecondary ? [primary, useSecondary] : [primary],
      metrics: [
        'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
        'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
        'ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
        'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
        'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE',
      ],
    };
  },
  summary: (input) => {
    const slice = input.group_by === 'none' ? '' : ` x ${input.group_by}`;
    return `Viewability by ${input.by}${slice}, ${input.date_range.start}..${input.date_range.end} (top ${input.top_n})`;
  },
});
