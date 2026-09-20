import { z } from 'zod';
import { resolveDateRange } from '../dates.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { cellText, type Cell } from '../values.js';
import { num, derived } from '../derived.js';
import { READS_GAM, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';
import { dateRangeInput, HISTORICAL_RANGE } from '../tool-input.js';
import type { DateRange, ReportQuery } from '../gam-client.js';
import type { InputReport } from '../envelope.js';
import type { GamErrorEnvelope } from '../errors.js';

// The eleven dimensions spec §4.3 lists, in its order, plus IMPRESSIONS.
// find_anomalies' pacing_underdelivery kind shares this query and row
// mapping through pacingRows() below, rather than writing the dimensions a
// second time.
export const PACING_DIMENSIONS = [
  'LINE_ITEM_ID',
  'LINE_ITEM_NAME',
  'LINE_ITEM_TYPE',
  'LINE_ITEM_PRIMARY_GOAL_TYPE',
  'LINE_ITEM_PRIMARY_GOAL_UNIT_TYPE',
  'LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE',
  'LINE_ITEM_START_DATE',
  'LINE_ITEM_END_DATE',
  'LINE_ITEM_UNLIMITED_END',
  'LINE_ITEM_LIFETIME_IMPRESSIONS',
  'LINE_ITEM_DELIVERY_INDICATOR',
];

// Every caller of pacingRows carries this: the indicator and lifetime
// impressions are computed by GAM live, as of provenance.run_time (or each
// input's own run_time), not as of date_range.end (spec §1.1, §4.3).
export const PACING_LIVE_VALUE_WARNING =
  'LINE_ITEM_DELIVERY_INDICATOR and LINE_ITEM_LIFETIME_IMPRESSIONS are live values as of run_time, not as of the end of date_range.';

export type PacingRow = Record<string, unknown>;

// LINE_ITEM_UNLIMITED_END is declared `type: "string"` in the generated
// schema (src/schema-generated.ts:347), same as LINE_ITEM_DELIVERY_INDICATOR
// -- which the live probe proved arrives as a doubleValue despite that same
// declaration (spec line 79). The spec's evidence table never records
// UNLIMITED_END's own wire kind, so the declared type cannot be trusted for
// it either: GAM may send a real boolValue, or a stringValue "true"/"false".
// A bare `=== true` would silently miss the string form and leak the
// 2037-01-01 sentinel -- exactly the bug §1.2 exists to prevent. Accept both
// wire forms; anything else (false, absent, an unrecognized string) is false,
// which is the conservative outcome -- the real end date still passes through.
function isUnlimitedEnd(cell: Cell): boolean {
  if (cell === true) return true;
  if (typeof cell === 'string') return cell.trim().toLowerCase() === 'true';
  return false;
}

// Reads LINE_ITEM_DELIVERY_INDICATOR through num(), never Number(cellText()):
// the field is declared `string` in the generated schema but arrives as a
// `doubleValue`; convertValue types a row from the value it actually holds,
// but a result with no rows for this column falls back to the declared
// schema type, and Number(cellText(<absent>)) is 0 -- indistinguishable from
// a real, reported 0. num() stays null for an absent value (spec: absence is
// not permission).
function mapPacingRow(r: Record<string, Cell>): { row: PacingRow; nullInput: boolean } {
  const goalType = cellText(r.LINE_ITEM_PRIMARY_GOAL_TYPE);
  const isLifetime = goalType === 'LIFETIME';
  const indicator = num(r.LINE_ITEM_DELIVERY_INDICATOR);
  // A LIFETIME row whose indicator GAM didn't return: a null input to a
  // computed field, surfaced through derivedEnvelope's null_input_rows.
  const nullInput = isLifetime && indicator === null;
  // §1.2's last paragraph: an open-ended line item's end date is null, never
  // the 2037-01-01 sentinel GAM sends, when LINE_ITEM_UNLIMITED_END is true.
  const unlimitedEnd = isUnlimitedEnd(r.LINE_ITEM_UNLIMITED_END);
  const endDate = unlimitedEnd ? null : (r.LINE_ITEM_END_DATE ?? null);
  const derivedBlock = isLifetime
    ? derived({
        value: indicator,
        method: "GAM's LINE_ITEM_DELIVERY_INDICATOR, unchanged, reported because the primary goal type is LIFETIME.",
        heuristic: false,
        inputs: { LINE_ITEM_PRIMARY_GOAL_TYPE: goalType || null, LINE_ITEM_DELIVERY_INDICATOR: indicator },
      })
    : derived({
        value: null,
        method: 'delivery_indicator is only meaningful for a LIFETIME primary goal.',
        heuristic: false,
        inputs: { LINE_ITEM_PRIMARY_GOAL_TYPE: goalType || null },
        reason: 'no lifetime goal',
      });
  return {
    nullInput,
    row: {
      LINE_ITEM_ID: r.LINE_ITEM_ID ?? null,
      LINE_ITEM_NAME: r.LINE_ITEM_NAME ?? null,
      LINE_ITEM_TYPE: r.LINE_ITEM_TYPE ?? null,
      LINE_ITEM_PRIMARY_GOAL_TYPE: r.LINE_ITEM_PRIMARY_GOAL_TYPE ?? null,
      LINE_ITEM_PRIMARY_GOAL_UNIT_TYPE: r.LINE_ITEM_PRIMARY_GOAL_UNIT_TYPE ?? null,
      LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE: r.LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE ?? null,
      LINE_ITEM_START_DATE: r.LINE_ITEM_START_DATE ?? null,
      LINE_ITEM_END_DATE: endDate,
      LINE_ITEM_UNLIMITED_END: r.LINE_ITEM_UNLIMITED_END ?? null,
      LINE_ITEM_LIFETIME_IMPRESSIONS: r.LINE_ITEM_LIFETIME_IMPRESSIONS ?? null,
      IMPRESSIONS: r.IMPRESSIONS ?? null,
      delivery_indicator: isLifetime ? indicator : null,
      derived: derivedBlock,
    },
  };
}

export type PacingRowsResult = {
  rows: PacingRow[];
  input: InputReport;
  warnings: string[];
  // How many rows had a null input to the delivery_indicator computation
  // (spec §1.4): a LIFETIME row GAM didn't report an indicator for.
  nullInputRows: number;
};

// The report and row mapping pacing_status and find_anomalies' pacing kind
// share: one query over one range, with delivery_indicator carried through
// only for a LIFETIME primary goal and the unlimited-end rule applied to the
// end date.
export async function pacingRows(
  ctx: ToolContext,
  dateRange: DateRange,
  filters: NonNullable<ReportQuery['filters']>,
  tool: string,
): Promise<PacingRowsResult | GamErrorEnvelope> {
  const query: ReportQuery = { dimensions: PACING_DIMENSIONS, metrics: ['IMPRESSIONS'], filters };
  const result = await executeReportRows(ctx, query, dateRange, tool);
  if ('error' in result) return result;
  let nullInputRows = 0;
  const rows = result.rows.map((r) => {
    const mapped = mapPacingRow(r);
    if (mapped.nullInput) nullInputRows++;
    return mapped.row;
  });
  return { rows, input: result.input, warnings: result.warnings, nullInputRows };
}

const inputSchema = z.object({
  date_range: dateRangeInput(
    `${HISTORICAL_RANGE} Defaults to last_7_days. delivery_indicator is a live GAM value either way -- the range only ` +
    'selects which line items appear -- and a month_to_date default would fail on the first day of every month.',
  ).default({ relative: 'last_7_days' }),
  line_item_ids: z.array(z.number().int().positive()).optional()
    .describe('Only these line items.'),
  order_ids: z.array(z.number().int().positive()).optional()
    .describe('Only line items of these orders.'),
}).strict();

export const pacingStatusTool: ToolDefinition<typeof inputSchema> = {
  name: 'pacing_status',
  description:
    "Per-line-item delivery status over date_range (default last_7_days). Each row's delivery_indicator is GAM's own " +
    "live ratio of delivered to expected-so-far, reported only when the line item's primary goal type is LIFETIME; " +
    'other goal types get null with derived.reason "no lifetime goal". Optional filter by line_item_ids or order_ids.',
  input: inputSchema,
  annotations: READS_GAM,
  async handler(input, ctx: ToolContext) {
    // input.date_range has a schema default, but a caller that invokes this
    // handler directly (bypassing zod parsing) can still hand over undefined.
    const dateRange = resolveDateRange(input.date_range ?? { relative: 'last_7_days' }, {
      timezone: ctx.timezone,
      now: ctx.now,
      rule: 'historical',
    });
    if ('error' in dateRange) return dateRange;
    const filters: NonNullable<ReportQuery['filters']> = [
      ...(input.line_item_ids?.length
        ? [{ field: 'LINE_ITEM_ID', op: 'IN' as const, value: input.line_item_ids }]
        : []),
      ...(input.order_ids?.length
        ? [{ field: 'ORDER_ID', op: 'IN' as const, value: input.order_ids }]
        : []),
    ];
    const result = await pacingRows(ctx, dateRange, filters, 'pacing_status');
    if ('error' in result) return result;
    return derivedEnvelope(ctx, {
      summary: `Pacing status, ${dateRange.start}..${dateRange.end}: ${result.rows.length} line item(s).`,
      inputs: [result.input],
      rows: result.rows,
      total_row_count: result.rows.length,
      warnings: [...result.warnings, PACING_LIVE_VALUE_WARNING],
      null_input_rows: result.nullInputRows,
    });
  },
};
