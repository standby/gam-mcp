import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';
import type { ReportQuery } from '../gam-client.js';

// Primary breakdown dimension for the video completion funnel.
const PRIMARY = {
  ad_unit: 'AD_UNIT_NAME',
  placement: 'VIDEO_PLCMT_NAME',
  size: 'RENDERED_CREATIVE_SIZE',
  duration: 'VIDEO_AD_DURATION',
} as const;

const SECONDARY = {
  none: null,
  day: 'DATE',
  country: 'COUNTRY_NAME',
  device: 'DEVICE_CATEGORY_NAME',
} as const;

const inputSchema = z.object({
  date_range: dateRangeInput(HISTORICAL_RANGE),
  by: z
    .enum(['ad_unit', 'placement', 'size', 'duration'])
    .default('ad_unit')
    .describe("Primary slice: 'ad_unit', 'placement' (in-stream/out-stream), 'size', or 'duration'."),
  group_by: z
    .enum(['none', 'day', 'country', 'device'])
    .default('none')
    .describe('Optional secondary slice.'),
  top_n: z.number().int().min(1).max(500).default(50)
    .describe('Maximum rows to surface.'),
}).strict();

export const videoBreakdownTool = buildReportTool({
  name: 'video_breakdown',
  description:
    "Video completion funnel. Returns starts → 25% → 50% → 75% → completes plus completion rate, " +
    "broken down by ad unit, video placement type (in-stream / out-stream), creative size, or ad duration over a date range. " +
    "Use to find where viewers drop off and which inventory/format completes best. " +
    "by selects the primary slice; group_by adds a secondary slice (day | country | device). " +
    "For view-through rate / average view time or to pair with revenue, use run_report with the VIDEO_VIEWERSHIP_* metrics.",
  input: inputSchema,
  buildQuery: (input): ReportQuery => {
    const primary = PRIMARY[input.by];
    const secondary = SECONDARY[input.group_by];
    return {
      dimensions: secondary ? [primary, secondary] : [primary],
      metrics: [
        'VIDEO_VIEWERSHIP_STARTS',
        'VIDEO_VIEWERSHIP_FIRST_QUARTILES',
        'VIDEO_VIEWERSHIP_MIDPOINTS',
        'VIDEO_VIEWERSHIP_THIRD_QUARTILES',
        'VIDEO_VIEWERSHIP_COMPLETES',
        'VIDEO_VIEWERSHIP_COMPLETION_RATE',
      ],
    };
  },
  summary: (input, range) => {
    const slice = input.group_by === 'none' ? '' : ` x ${input.group_by}`;
    return `Video funnel by ${input.by}${slice}, ${range.start}..${range.end} (top ${input.top_n})`;
  },
});
