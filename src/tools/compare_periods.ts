import { z } from 'zod';
import { gamError, type GamErrorEnvelope } from '../errors.js';
import { previousPeriod, previousYear, resolveDateRange, type ResolvedRange } from '../dates.js';
import { validateCombo } from '../schema.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { cellText, type Cell } from '../values.js';
import { READS_GAM, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';
import { dateField, dateRangeInput, filterInput, HISTORICAL_RANGE } from '../tool-input.js';

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
    "Output rows carry <metric>, <metric>_prev, and <metric>_delta_pct (signed percent change; null when prev is 0 or row is new). " +
    "Sorted by the first metric's current-period value, descending. top_n caps result rows.",
  input: inputSchema,
  annotations: READS_GAM,
  async handler(input, ctx: ToolContext) {
    const comboError = validateCombo({ dimensions: input.dimensions, metrics: input.metrics });
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
    const query: ReportQuery = {
      dimensions: input.dimensions,
      metrics: input.metrics,
      filters: input.filters,
    };

    try {
      // Run both reports in parallel — they're independent createReport calls.
      const [base, prev] = await Promise.all([
        executeReportRows(ctx, query, baseRange, 'compare_periods'),
        executeReportRows(ctx, query, prevRange, 'compare_periods'),
      ]);
      if ('error' in base) return base;
      if ('error' in prev) return prev;
      const joined = joinAndCompare(base.rows, prev.rows, input.dimensions, input.metrics);
      if ('error' in joined) return joined;
      const sorted = sortByPrimaryMetric(joined, input.metrics[0]);
      const top = sorted.slice(0, input.top_n);
      const summary =
        `Compare: dims=[${input.dimensions.join(',')}] metrics=[${input.metrics.join(',')}] ` +
        `base=${baseRange.start}..${baseRange.end} vs prev=${prevRange.start}..${prevRange.end} ` +
        `(${joined.length} keys, top_n=${input.top_n})`;
      return derivedEnvelope(ctx, {
        summary,
        inputs: [base.input, prev.input],
        rows: top,
        total_row_count: joined.length,
        warnings: [...base.warnings, ...prev.warnings],
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
): Record<string, string>[] | GamErrorEnvelope {
  // Checked independently — a duplicate in the base is exactly as wrong as
  // one in the previous period, so both sides are checked, not just one.
  const baseByKey = groupByKey(baseRows, dims, 'base');
  if ('error' in baseByKey) return baseByKey;
  const prevByKey = groupByKey(prevRows, dims, 'previous');
  if ('error' in prevByKey) return prevByKey;

  const seenPrev = new Set<string>();
  const out: Record<string, string>[] = [];

  for (const [k, b] of baseByKey) {
    const p = prevByKey.get(k);
    if (p) seenPrev.add(k);
    out.push(buildRow(b, p, dims, metrics));
  }
  // Rows that exist only in the previous period.
  for (const [k, p] of prevByKey) {
    if (seenPrev.has(k)) continue;
    out.push(buildRow(undefined, p, dims, metrics));
  }
  return out;
}

function buildRow(
  base: Record<string, Cell> | undefined,
  prev: Record<string, Cell> | undefined,
  dims: string[],
  metrics: string[],
): Record<string, string> {
  const row: Record<string, string> = {};
  for (const d of dims) row[d] = cellText(base?.[d] ?? prev?.[d]);
  for (const m of metrics) {
    const cur = base ? toNum(base[m]) : null;
    const old = prev ? toNum(prev[m]) : null;
    row[m] = cur === null ? '' : String(cur);
    row[`${m}_prev`] = old === null ? '' : String(old);
    row[`${m}_delta_pct`] = pctChange(cur, old);
  }
  return row;
}

function toNum(v: Cell | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pctChange(cur: number | null, prev: number | null): string {
  if (cur === null || prev === null) return ''; // missing on one side
  if (prev === 0) return cur === 0 ? '0' : ''; // undefined when prev is 0
  return (((cur - prev) / prev) * 100).toFixed(2);
}

function sortByPrimaryMetric(
  rows: Record<string, string>[],
  primary: string,
): Record<string, string>[] {
  return [...rows].sort((a, b) => (toNum(b[primary]) ?? 0) - (toNum(a[primary]) ?? 0));
}
