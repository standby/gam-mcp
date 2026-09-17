import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import { dateRangeInput } from '../tool-input.js';
import type { ReportQuery } from '../gam-client.js';

// FUTURE_SELL_THROUGH accepts a narrower dimension set than the historical
// report — notably there is no device/browser/platform slice. Each entry is the
// [id, name] pair for one supported entity, so rows stay readable and still
// filterable by id.
const PRIMARY = {
  ad_unit:   ['AD_UNIT_ID', 'AD_UNIT_NAME'],
  placement: ['PLACEMENT_ID', 'PLACEMENT_NAME'],
  line_item: ['LINE_ITEM_ID', 'LINE_ITEM_NAME'],
  order:     ['ORDER_ID', 'ORDER_NAME'],
} as const;

const METRICS = [
  'SELL_THROUGH_FORECASTED_IMPRESSIONS',
  'SELL_THROUGH_RESERVED_IMPRESSIONS',
  'SELL_THROUGH_AVAILABLE_IMPRESSIONS',
  'SELL_THROUGH_SELL_THROUGH_RATE',
] as const;

// The single most important caveat: nothing here was measured.
export const SELL_THROUGH_FORECAST_WARNING =
  'These are Google\'s forecasts, not measurements. Nothing in this report has happened yet: ' +
  'forecasted impressions are a prediction of future traffic, and forecast accuracy degrades the ' +
  'further out the window goes — a next-week number is far more trustworthy than a next-quarter one. ' +
  'Reserved impressions reflect only line items booked as of right now, so both the reserved and ' +
  'available columns move as new bookings land or existing ones are cancelled. Treat the numbers as ' +
  'a snapshot for planning, not a commitment, and re-run before promising inventory.';

const SCOPE_WARNING =
  'Sell-through covers reservable (guaranteed) delivery only — the availability GAM forecasts against ' +
  'booked line items. It says nothing about programmatic/backfill demand, and it cannot be combined ' +
  'with delivery or revenue metrics, which come from a different GAM report type.';

const inputSchema = z.object({
  date_range: dateRangeInput(
    'The forward-looking window to forecast, as { start, end } dates: it must start today or later in the ' +
    'date time zone (GAM_TIMEZONE), because a past window returns nothing. Relative ranges are refused. ' +
    'Keep the window as near-term as the question allows; forecasts get less reliable further out.',
  ),
  by: z
    .enum(['ad_unit', 'placement', 'line_item', 'order'])
    .default('ad_unit')
    .describe(
      "Primary slice. 'ad_unit' / 'placement' answer \"what inventory is still sellable\"; " +
      "'line_item' / 'order' answer \"can this booking still be filled\". " +
      "GAM's sell-through report supports only these four entities; it has no device-level slice at all.",
    ),
  ids: z
    .array(z.number().int().positive())
    .optional()
    .describe('Restrict to specific IDs of the `by` entity. Find them via lookup.'),
}).strict();

export const sellThroughTool = buildReportTool({
  name: 'sell_through',
  description:
    'Forward-looking inventory availability, from GAM\'s future sell-through forecast. Answers ' +
    '"do we have inventory to sell", "are we oversold", "what is available next month", and ' +
    '"can we take this booking" — before committing to an advertiser. ' +
    'Returns, per ad unit / placement / line item / order over a FUTURE date range: ' +
    'forecasted impressions (total traffic GAM predicts), reserved impressions (the slice of that ' +
    'forecast already reserved by booked line items), available impressions (the forecasted ' +
    'impressions not reserved by any line item, i.e. forecasted minus reserved — what is still ' +
    'sellable), and sell-through rate (the fraction of forecasted impressions reserved by line ' +
    'items, i.e. reserved / forecasted). A rate at or above 1.0 means oversold. ' +
    'This is the forward half of pacing_status: pacing_status shows a line item is underdelivering, ' +
    'sell_through shows whether the inventory to catch it up actually exists.',
  input: inputSchema,
  buildQuery: (input): ReportQuery => {
    const [idDim, nameDim] = PRIMARY[input.by];
    return {
      dimensions: [idDim, nameDim],
      metrics: [...METRICS],
      ...(input.ids?.length && {
        filters: [{ field: idDim, op: 'IN' as const, value: input.ids }],
      }),
      report_type: 'FUTURE_SELL_THROUGH',
    };
  },
  summary: (input, range) => {
    const scope = input.ids?.length ? ` (${input.ids.length} id(s))` : '';
    return `Forecast sell-through by ${input.by}${scope}, ${range.start}..${range.end}`;
  },
  warnings: () => [SELL_THROUGH_FORECAST_WARNING, SCOPE_WARNING],
});
