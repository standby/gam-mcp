import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';
import type { ReportQuery } from '../gam-client.js';

// Primary breakdown dimension. Only a handful of the AD_SPEED-compatible
// dimensions are useful for latency triage — placement, form factor, network
// conditions, and creative weight.
const PRIMARY = {
  ad_unit: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
  device: ['DEVICE_CATEGORY_NAME'],
  country: ['COUNTRY_NAME'],
  creative_size: ['RENDERED_CREATIVE_SIZE'],
} as const;

// The latency buckets GAM reports, in ascending order. Every family below uses
// the same six boundaries, so rows read as a left-to-right histogram.
const BUCKETS = ['0_500', '500_1000', '1000_2000', '2000_4000', '4000_8000', 'GT_8000'] as const;
const buckets = (family: string): string[] => BUCKETS.map((b) => `${family}_${b}_PERCENT`);

// AD_SPEED exposes 34 metrics; returning them all makes a row unreadable, so
// `focus` picks one coherent family. IMPRESSIONS leads every list because the
// other columns are percentages — without a volume column a 90%-slow row of
// 200 impressions looks identical to one of 20 million.
const FOCUS_METRICS: Record<'creative_load' | 'page_timing' | 'unviewed_reason', string[]> = {
  creative_load: ['IMPRESSIONS', ...buckets('CREATIVE_LOAD_TIME')],
  page_timing: [
    'IMPRESSIONS',
    ...buckets('DOM_LOAD_TO_FIRST_AD_REQUEST'),
    ...buckets('DOM_LOAD_TO_TAG_LOAD_TIME'),
    ...buckets('TAG_LOAD_TO_FIRST_AD_REQUEST'),
  ],
  unviewed_reason: [
    'IMPRESSIONS',
    'UNVIEWED_REASON_USER_SCROLLED_BEFORE_AD_FILLED_PERCENT',
    'UNVIEWED_REASON_USER_SCROLLED_BEFORE_AD_LOADED_PERCENT',
    'UNVIEWED_REASON_USER_SCROLLED_BEFORE_ONE_SECOND_PERCENT',
    'UNVIEWED_REASON_SLOT_NEVER_ENTERED_VIEWPORT_PERCENT',
    'UNVIEWED_REASON_OTHER_PERCENT',
  ],
};

export const AD_SPEED_DISTRIBUTION_WARNING =
  'Every *_PERCENT column is a share of impressions within its family, not a count: the six ' +
  'latency buckets of one family (0-500ms, 500ms-1s, 1s-2s, 2s-4s, 4s-8s, >8s) sum to ~100% ' +
  'per row. Read a row as a distribution — compare the share sitting in the slow buckets — and ' +
  'never sum buckets together or add a percentage across rows. Weight by IMPRESSIONS before ' +
  'acting: a bad distribution on tiny volume is noise.';

const PAGE_TIMING_WARNING =
  'The three page_timing families decompose one funnel: page navigation to tag loaded, plus tag ' +
  'loaded to first ad request, together account for page navigation to first ad request. Compare ' +
  'the two stages to see whether the delay is the tag arriving late or the tag being slow to ask ' +
  'for an ad. These timings are only observed where GAM sees browser page timing, so rows for ' +
  'inventory without it may be blank.';

const inputSchema = z.object({
  date_range: dateRangeInput(HISTORICAL_RANGE),
  by: z
    .enum(['ad_unit', 'device', 'country', 'creative_size'])
    .default('ad_unit')
    .describe(
      "Primary slice: 'ad_unit' (which placements are slow), 'device' (form factor), " +
      "'country' (network conditions), or 'creative_size' (rendered size, i.e. creative weight).",
    ),
  focus: z
    .enum(['creative_load', 'page_timing', 'unviewed_reason'])
    .default('creative_load')
    .describe(
      "Which latency family to return. 'creative_load' = how long the creative took to render " +
      "once requested. 'page_timing' = the pre-request funnel (page navigation to tag loaded, " +
      "tag loaded to first ad request, and page navigation to first ad request end to end). " +
      "'unviewed_reason' = why impressions were never viewed (user scrolled past before the ad " +
      'filled/loaded, before 1 second on screen, slot never entered the viewport, or other).',
    ),
}).strict();

export const adSpeedTool = buildReportTool({
  name: 'ad_speed',
  description:
    "Ad latency and page-speed diagnostics from GAM's Ad Speed report. Returns the distribution of " +
    'impressions across load-time buckets (0-500ms, 500ms-1s, 1s-2s, 2s-4s, 4s-8s, >8s) and the ' +
    'reasons impressions went unviewed, sliced by ad unit, device, country, or rendered creative size. ' +
    'Use this when asked why ads are slow, why ads load late, or why viewability is low — slow ' +
    'creatives and late first ad requests mean users scroll past before the ad paints. ' +
    "focus='creative_load' shows creative render time; focus='page_timing' shows the funnel before an " +
    "ad is even requested; focus='unviewed_reason' attributes unviewed impressions to scrolling vs " +
    'slots that never entered the viewport. Complements viewability_breakdown: that tool shows which ' +
    'placements are unviewable, this one shows why.',
  input: inputSchema,
  buildQuery: (input): ReportQuery => ({
    dimensions: [...PRIMARY[input.by]],
    metrics: FOCUS_METRICS[input.focus],
    report_type: 'AD_SPEED',
  }),
  summary: (input, range) =>
    `Ad speed (${input.focus}) by ${input.by}, ${range.start}..${range.end}`,
  warnings: (input) =>
    input.focus === 'page_timing'
      ? [AD_SPEED_DISTRIBUTION_WARNING, PAGE_TIMING_WARNING]
      : [AD_SPEED_DISTRIBUTION_WARNING],
});
