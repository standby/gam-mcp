import { z } from 'zod';
import { gamError } from '../errors.js';
import { previousPeriod, previousYear, resolveDateRange, type ResolvedRange } from '../dates.js';
import { validateCombo } from '../schema.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { cellText, type Cell } from '../values.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';
import { dateField, dateRangeInput } from '../tool-input.js';

const filterSchema = z.object({
  field: z.string(),
  op: z.enum(['=', 'IN', '!=', 'CONTAINS', 'NOT_CONTAINS']).default('='),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
});

const inputSchema = z.object({
  dimensions: z.array(z.string()).min(1).max(10),
  metrics: z.array(z.string()).min(1).max(10),
  base_range: dateRangeInput('The period to compare; it must end by yesterday.'),
  comparison: z.union([
    z.enum(['previous_period', 'previous_year']),
    z.object({
      start: dateField('First day of the comparison period, inclusive, as YYYY-MM-DD.'),
      end: dateField('Last day of the comparison period, inclusive, as YYYY-MM-DD; by yesterday.'),
    }).strict(),
  ]),
  filters: z.array(filterSchema).optional(),
  top_n: z.number().int().min(1).max(500).default(50),
});

export const comparePeriodsTool: ToolDefinition<typeof inputSchema> = {
  name: 'compare_periods',
  description:
    "Run the same report over two date ranges and return per-row deltas. Useful for week-over-week, month-over-month, year-over-year decisions. " +
    "comparison can be 'previous_period' (same length, immediately preceding base_range), 'previous_year' (base shifted back 1 year), or explicit {start,end}. " +
    "Output rows carry <metric>, <metric>_prev, and <metric>_delta_pct (signed percent change; null when prev is 0 or row is new). " +
    "Sorted by the first metric's current-period value, descending. top_n caps result rows.",
  input: inputSchema,
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

function joinAndCompare(
  baseRows: Record<string, Cell>[],
  prevRows: Record<string, Cell>[],
  dims: string[],
  metrics: string[],
): Record<string, string>[] {
  const key = (r: Record<string, Cell>) => dims.map((d) => cellText(r[d])).join('\u0001');
  const prevByKey = new Map(prevRows.map((r) => [key(r), r]));
  const seenPrev = new Set<string>();
  const out: Record<string, string>[] = [];

  for (const b of baseRows) {
    const k = key(b);
    const p = prevByKey.get(k);
    if (p) seenPrev.add(k);
    out.push(buildRow(b, p, dims, metrics));
  }
  // Rows that exist only in the previous period.
  for (const p of prevRows) {
    const k = key(p);
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
