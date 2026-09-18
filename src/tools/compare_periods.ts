import { z } from 'zod';
import { gamError, type GamErrorEnvelope } from '../errors.js';
import { previousPeriod, previousYear, resolveDateRange, type ResolvedRange } from '../dates.js';
import { canonicalizeQuery, validateCombo } from '../schema.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { derived } from '../derived.js';
import { cellText, type Cell } from '../values.js';
import { READS_GAM, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';
import { dateField, dateRangeInput, filterInput, HISTORICAL_RANGE } from '../tool-input.js';

// Fixed across every row/metric: spec §4.6 wants the rule stated, not just
// implied by a null. This is arithmetic, not inference (derived.heuristic is
// always false) -- the three null/zero branches below are the whole rule.
const DELTA_PCT_METHOD =
  'Signed percent change from the comparison period to base_range: ((base - prev) / prev) * 100, rounded to 2 ' +
  'decimals. value is null when the metric is missing (not reported by GAM) in either period -- a null input; ' +
  'value is also null when prev is exactly 0 and base is not, because the percent change is undefined/unbounded, ' +
  'though this is not counted as a null-input row since neither input is itself missing; value is 0 when both ' +
  'periods report exactly 0 (no change).';

const inputSchema = z.object({
  dimensions: z.array(z.string()).min(1).max(10)
    .describe('1-10 dimension names from describe_schema; rows of the two periods are matched on all of them.'),
  metrics: z.array(z.string()).min(1).max(10)
    .describe('1-10 metric names from describe_schema to compare.'),
  base_range: dateRangeInput(HISTORICAL_RANGE),
  comparison: z.union([
    z.enum(['previous_period', 'previous_year'])
      .describe('"previous_period": the same number of days just before; "previous_year": the same dates a year earlier.'),
    z.object({
      start: dateField('First day of the comparison period, inclusive, as YYYY-MM-DD.'),
      end: dateField('Last day of the comparison period, inclusive, as YYYY-MM-DD. It must be yesterday or earlier.'),
    }).strict().describe('Explicit comparison dates.'),
  ]).describe('The period to compare base_range with.'),
  filters: z.array(filterInput).optional()
    .describe('Conditions every row must meet in both periods; all of them apply.'),
  top_n: z.number().int().min(1).max(500).default(50)
    .describe('Most rows to return, 1-500, largest first by the first metric.'),
}).strict();

export const comparePeriodsTool: ToolDefinition<typeof inputSchema> = {
  name: 'compare_periods',
  description:
    "Run the same report over two date ranges and return per-row deltas. Useful for week-over-week, month-over-month, year-over-year decisions. " +
    "comparison can be 'previous_period' (same length, immediately preceding base_range), 'previous_year' (base shifted back 1 year), or explicit {start,end}. " +
    "Output rows carry <metric> and <metric>_prev (each '' when that period didn't report the metric), plus " +
    "<metric>_delta_pct as a derived object ({value, method, heuristic: false, inputs}): value is the signed percent " +
    "change, null when the metric is missing in either period or when prev is exactly 0 and the metric isn't " +
    "(undefined change), and 0 when both periods report exactly 0. " +
    "Sorted by the first metric's current-period value, descending. top_n caps result rows.",
  input: inputSchema,
  annotations: READS_GAM,
  async handler(input, ctx: ToolContext) {
    // canonicalizeQuery resolves familiar names (e.g. CREATIVE_SIZE) in both
    // dimensions and filter fields before validating, the same as run_report.
    const canonical = canonicalizeQuery({
      dimensions: input.dimensions,
      metrics: input.metrics,
      filters: input.filters,
    });
    const { dimensions, filters } = canonical.query;

    const comboError = validateCombo({ dimensions, metrics: input.metrics });
    if (comboError) {
      return gamError('INVALID_INPUT', { reason: comboError, hint: 'Call describe_schema for valid names.' });
    }

    const dates = { timezone: ctx.timezone, now: ctx.now, rule: 'historical' as const };
    const baseRange = resolveDateRange(input.base_range, { ...dates, field: 'base_range' });
    if ('error' in baseRange) return baseRange;
    const prevRange = typeof input.comparison === 'object'
      ? resolveDateRange(input.comparison, { ...dates, field: 'comparison' })
      : comparisonRange(baseRange, input.comparison);
    if ('error' in prevRange) return prevRange;
    const query: ReportQuery = { dimensions, metrics: input.metrics, filters };

    try {
      // Run both reports in parallel — they're independent createReport calls.
      const [base, prev] = await Promise.all([
        executeReportRows(ctx, query, baseRange, 'compare_periods'),
        executeReportRows(ctx, query, prevRange, 'compare_periods'),
      ]);
      if ('error' in base) return base;
      if ('error' in prev) return prev;
      const joined = joinAndCompare(base.rows, prev.rows, dimensions, input.metrics);
      if ('error' in joined) return joined;
      const sorted = sortByPrimaryMetric(joined.rows, input.metrics[0]);
      const top = sorted.slice(0, input.top_n);
      const summary =
        `Compare: dims=[${dimensions.join(',')}] metrics=[${input.metrics.join(',')}] ` +
        `base=${baseRange.start}..${baseRange.end} vs prev=${prevRange.start}..${prevRange.end} ` +
        `(${joined.rows.length} keys, top_n=${input.top_n})`;
      return derivedEnvelope(ctx, {
        summary,
        inputs: [base.input, prev.input],
        rows: top,
        total_row_count: joined.rows.length,
        warnings: [...canonical.warnings, ...base.warnings, ...prev.warnings],
        null_input_rows: joined.nullInputRows,
      });
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

// Both are computed from a checked base range, so they end before it does.
function comparisonRange(base: ResolvedRange, comparison: 'previous_period' | 'previous_year'): ResolvedRange {
  return comparison === 'previous_year' ? previousYear(base) : previousPeriod(base);
}

const joinKey = (r: Record<string, Cell>, dims: string[]) =>
  dims.map((d) => cellText(r[d])).join('\u0001');

// The dimension→value map a duplicate key error names, built from the row
// that collided rather than the opaque joined key string.
const keyDetails = (r: Record<string, Cell>, dims: string[]): Record<string, string> =>
  Object.fromEntries(dims.map((d) => [d, cellText(r[d])]));

// Groups one period's rows by the full dimension tuple. A key that occurs
// twice means the join cannot tell which row the other period's row should
// be compared against, so this refuses rather than letting a Map silently
// keep only the last row written under that key (spec §4.1, finding F8).
function groupByKey(
  rows: Record<string, Cell>[],
  dims: string[],
  period: 'base' | 'previous',
): Map<string, Record<string, Cell>> | GamErrorEnvelope {
  const byKey = new Map<string, Record<string, Cell>>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = joinKey(r, dims);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (!byKey.has(k)) byKey.set(k, r);
  }
  for (const [k, count] of counts) {
    if (count > 1) {
      return gamError('DUPLICATE_JOIN_KEY', { key: keyDetails(byKey.get(k)!, dims), period });
    }
  }
  return byKey;
}

function joinAndCompare(
  baseRows: Record<string, Cell>[],
  prevRows: Record<string, Cell>[],
  dims: string[],
  metrics: string[],
): { rows: Record<string, unknown>[]; nullInputRows: number } | GamErrorEnvelope {
  // Checked independently — a duplicate in the base is exactly as wrong as
  // one in the previous period, so both sides are checked, not just one.
  const baseByKey = groupByKey(baseRows, dims, 'base');
  if ('error' in baseByKey) return baseByKey;
  const prevByKey = groupByKey(prevRows, dims, 'previous');
  if ('error' in prevByKey) return prevByKey;

  const seenPrev = new Set<string>();
  const out: Record<string, unknown>[] = [];
  // Counted from the outcome, once per row, the way
  // diagnose_floor_pricing.ts's nullInputRows is: a row counts here only
  // when at least one of its metrics' delta came out null because that
  // metric was missing (not reported) on one side -- never for the
  // prev===0-but-base-isn't case, which is null for a different reason
  // (undefined percent change, not a missing input; see DELTA_PCT_METHOD).
  let nullInputRows = 0;

  for (const [k, b] of baseByKey) {
    const p = prevByKey.get(k);
    if (p) seenPrev.add(k);
    const built = buildRow(b, p, dims, metrics);
    if (built.nullInput) nullInputRows++;
    out.push(built.row);
  }
  // Rows that exist only in the previous period.
  for (const [k, p] of prevByKey) {
    if (seenPrev.has(k)) continue;
    const built = buildRow(undefined, p, dims, metrics);
    if (built.nullInput) nullInputRows++;
    out.push(built.row);
  }
  return { rows: out, nullInputRows };
}

function buildRow(
  base: Record<string, Cell> | undefined,
  prev: Record<string, Cell> | undefined,
  dims: string[],
  metrics: string[],
): { row: Record<string, unknown>; nullInput: boolean } {
  const row: Record<string, unknown> = {};
  for (const d of dims) row[d] = cellText(base?.[d] ?? prev?.[d]);
  let nullInput = false;
  for (const m of metrics) {
    const cur = base ? toNum(base[m]) : null;
    const old = prev ? toNum(prev[m]) : null;
    row[m] = cur === null ? '' : String(cur);
    row[`${m}_prev`] = old === null ? '' : String(old);
    const delta = deltaPct(cur, old);
    if (delta.nullInput) nullInput = true;
    row[`${m}_delta_pct`] = derived({
      value: delta.value,
      method: DELTA_PCT_METHOD,
      heuristic: false,
      inputs: { [`${m}_now`]: cur, [`${m}_prev`]: old },
    });
  }
  return { row, nullInput };
}

function toNum(v: Cell | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// nullInput is true only when a metric is missing (not reported by GAM) on
// one side -- a genuine null input to the computation. The prev===0 branch
// below also produces a null value (percent change from zero is undefined
// unless base is also zero), but both inputs are present and known there, so
// it is a different reason for null and does not set nullInput (spec: count
// only rows a null input actually nulled).
function deltaPct(cur: number | null, prev: number | null): { value: number | null; nullInput: boolean } {
  if (cur === null || prev === null) return { value: null, nullInput: true };
  if (prev === 0) return { value: cur === 0 ? 0 : null, nullInput: false };
  return { value: Number((((cur - prev) / prev) * 100).toFixed(2)), nullInput: false };
}

function sortByPrimaryMetric(
  rows: Record<string, unknown>[],
  primary: string,
): Record<string, unknown>[] {
  return [...rows].sort((a, b) => (toNum(b[primary] as Cell) ?? 0) - (toNum(a[primary] as Cell) ?? 0));
}
