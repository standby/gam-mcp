import { z } from 'zod';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { gamError } from '../errors.js';
import { resolveDateRange } from '../dates.js';
import { validateCombo } from '../schema.js';
import { readCsvGz } from '../output.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import type { GAMClient, ReportQuery, DateRange } from '../gam-client.js';

const RELATIVE = z.enum([
  'today', 'yesterday', 'last_7_days', 'last_30_days', 'last_week',
  'last_full_month', 'month_to_date', 'quarter_to_date', 'last_quarter', 'year_to_date',
]);

const dateRangeSchema = z.union([
  z.object({ start: z.string(), end: z.string() }),
  z.object({ relative: RELATIVE }),
]);

const filterSchema = z.object({
  field: z.string(),
  op: z.enum(['=', 'IN', '!=', 'CONTAINS', 'NOT_CONTAINS']).default('='),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
});

const inputSchema = z.object({
  dimensions: z.array(z.string()).min(1).max(10),
  metrics: z.array(z.string()).min(1).max(10),
  base_range: dateRangeSchema,
  comparison: z.union([
    z.literal('previous_period'),
    z.literal('previous_year'),
    z.object({ start: z.string(), end: z.string() }),
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

    let baseRange: DateRange;
    try {
      baseRange = resolveDateRange(input.base_range, ctx.timezone, ctx.now);
    } catch (e) {
      return gamError('INVALID_DATE_RANGE', { reason: e instanceof Error ? e.message : String(e) });
    }

    const prevRange = resolveComparison(baseRange, input.comparison);
    const query: ReportQuery = {
      dimensions: input.dimensions,
      metrics: input.metrics,
      filters: input.filters,
    };

    try {
      // Run both reports in parallel — they're independent createReport calls.
      const [baseRows, prevRows] = await Promise.all([
        runAndRead(ctx, query, baseRange),
        runAndRead(ctx, query, prevRange),
      ]);
      const joined = joinAndCompare(baseRows, prevRows, input.dimensions, input.metrics);
      const sorted = sortByPrimaryMetric(joined, input.metrics[0]);
      const top = sorted.slice(0, input.top_n);
      const summary =
        `Compare: dims=[${input.dimensions.join(',')}] metrics=[${input.metrics.join(',')}] ` +
        `base=${baseRange.start}..${baseRange.end} vs prev=${prevRange.start}..${prevRange.end} ` +
        `(${joined.length} keys, top_n=${input.top_n})`;
      return ctx.output!.fromInlineRows(top, summary);
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

function resolveComparison(
  base: DateRange,
  cmp: 'previous_period' | 'previous_year' | { start: string; end: string },
): DateRange {
  if (typeof cmp === 'object') return { start: cmp.start, end: cmp.end };
  const start = new Date(`${base.start}T00:00:00Z`);
  const end = new Date(`${base.end}T00:00:00Z`);
  if (cmp === 'previous_year') {
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    end.setUTCFullYear(end.getUTCFullYear() - 1);
    return { start: iso(start), end: iso(end) };
  }
  // previous_period: end = base.start - 1 day; start = end - (base length).
  const oneDay = 86_400_000;
  const lengthMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - oneDay);
  const prevStart = new Date(prevEnd.getTime() - lengthMs);
  return { start: iso(prevStart), end: iso(prevEnd) };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function runAndRead(
  ctx: ToolContext,
  query: ReportQuery,
  range: DateRange,
): Promise<Record<string, string>[]> {
  // Cache hit: skip the entire flow. Common for "show me last week, now
  // compare to previous week" — the base half is often identical to a
  // recent run_report.
  const cached = ctx.reportCache?.get(query, range);
  if (cached) return cached;

  const op = await ctx.client.createReport(query, range);
  const start = Date.now();
  let delay = 2000;
  const timeoutMs = ctx.reportTimeoutMs ?? 300_000;
  while (Date.now() - start < timeoutMs) {
    const s = await ctx.client.pollOperation(op.operation_name);
    if (s.state === 'done') {
      const dest = join(ctx.output!.tempDir, `${op.operation_name.replace(/[^\w]/g, '_')}.csv.gz`);
      await ctx.client.downloadReport(s.download_url, dest);
      const { rows } = await readCsvGz(dest);
      try { unlinkSync(dest); } catch { /* ignore */ }
      ctx.reportCache?.set(query, range, rows);
      return rows;
    }
    if (s.state === 'failed') throw new Error(`report failed: ${s.reason}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15_000);
  }
  throw new Error(`report timed out after ${timeoutMs}ms`);
}

function joinAndCompare(
  baseRows: Record<string, string>[],
  prevRows: Record<string, string>[],
  dims: string[],
  metrics: string[],
): Record<string, string>[] {
  const key = (r: Record<string, string>) => dims.map((d) => r[d] ?? '').join('\u0001');
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
  base: Record<string, string> | undefined,
  prev: Record<string, string> | undefined,
  dims: string[],
  metrics: string[],
): Record<string, string> {
  const row: Record<string, string> = {};
  for (const d of dims) row[d] = base?.[d] ?? prev?.[d] ?? '';
  for (const m of metrics) {
    const cur = base ? toNum(base[m]) : null;
    const old = prev ? toNum(prev[m]) : null;
    row[m] = cur === null ? '' : String(cur);
    row[`${m}_prev`] = old === null ? '' : String(old);
    row[`${m}_delta_pct`] = pctChange(cur, old);
  }
  return row;
}

function toNum(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
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
