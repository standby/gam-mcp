import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput } from '../tool-input.js';
import type { ReportQuery } from '../gam-client.js';

// GAM's Reach report accepts a much narrower set of slices than the historical
// report. Each entry is the [id, name] dimension pair for one supported entity
// — both are requested so rows are readable and still filterable by id.
const PRIMARY = {
  line_item:  ['LINE_ITEM_ID', 'LINE_ITEM_NAME'],
  order:      ['ORDER_ID', 'ORDER_NAME'],
  advertiser: ['ADVERTISER_ID', 'ADVERTISER_NAME'],
  ad_unit:    ['AD_UNIT_ID', 'AD_UNIT_NAME'],
} as const;

const SECONDARY = {
  none: null,
  country: 'COUNTRY_NAME',
  day: 'DATE',
} as const;

const inputSchema = z.object({
  date_range: dateRangeInput(
    'The dates to measure reach over: { start, end } or { relative }. The range must end by yesterday; ' +
    'reach data lags about 3 days, so the last days before today may return nothing.',
  ),
  by: z
    .enum(['line_item', 'order', 'advertiser', 'ad_unit'])
    .default('line_item')
    .describe("Primary slice. GAM's Reach report supports only these four entities."),
  group_by: z
    .enum(['none', 'country', 'day'])
    .default('none')
    .describe(
      "Optional secondary slice. 'country' is also what makes GAM populate the " +
      'UNIQUE_REACH_FREQUENCY column; rows still cannot be summed back into a total.',
    ),
  ids: z.array(z.number().int().positive()).max(500).optional()
    .describe('Restrict to specific IDs of the `by` entity (e.g. the line item IDs of one campaign). Find them via lookup.'),
}).strict();

export const reachReportTool = buildReportTool({
  name: 'reach_report',
  description:
    'Unique audience and delivered ad frequency, from GAM\'s Reach report. Returns total unique visitors ' +
    '(deduplicated people, not cookies), total reach impressions, and average impressions per unique visitor, ' +
    'sliced by line item / order / advertiser / ad unit and optionally by country or day. ' +
    'Use this to set a frequency cap from evidence rather than guesswork: the average impressions per unique ' +
    'visitor a campaign already delivered shows where its current frequency actually sits, and how much of the ' +
    'audience a cap would bite into. Reach metrics come from a separate GAM report type and cannot be combined ' +
    'with revenue/impression metrics; unique counts are NOT additive across rows. ' +
    'Ad-server/reservation delivery only — excludes Ad Exchange and AdSense.',
  input: inputSchema,
  buildQuery: (input): ReportQuery => {
    const [idDim, nameDim] = PRIMARY[input.by];
    const secondary = SECONDARY[input.group_by];
    return {
      dimensions: secondary ? [idDim, nameDim, secondary] : [idDim, nameDim],
      metrics: ['UNIQUE_VISITORS', 'REACH_IMPRESSIONS', 'AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR'],
      ...(input.ids?.length && {
        filters: [{ field: idDim, op: 'IN' as const, value: input.ids }],
      }),
      report_type: 'REACH',
    };
  },
  summary: (input, range) => {
    const slice = input.group_by === 'none' ? '' : ` x ${input.group_by}`;
    const scope = input.ids?.length ? ` (${input.ids.length} id(s))` : '';
    return `Reach & frequency by ${input.by}${slice}${scope}, ${range.start}..${range.end}`;
  },
});
