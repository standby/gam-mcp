import { z } from 'zod';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { gamError } from '../errors.js';
import { resolveDateRange } from '../dates.js';
import { readCsvGz } from '../output.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import type { GAMClient, ReportQuery, DateRange } from '../gam-client.js';

const inputSchema = z.object({
  kind: z.enum(['pacing_underdelivery', 'fill_rate_drops']),
  threshold_pct: z.number().min(0).max(100).optional(),
  top_n: z.number().int().min(1).max(200).default(25),
});

export const findAnomaliesTool: ToolDefinition<typeof inputSchema> = {
  name: 'find_anomalies',
  description:
    "Surface decision-relevant anomalies. " +
    "kind='pacing_underdelivery' flags line items whose month-to-date impressions are below their pro-rated goal " +
    "(threshold_pct = how far below pro-rated pace counts as 'at risk'; default 80, i.e. flag <80% of expected). " +
    "kind='fill_rate_drops' flags ad units whose fill rate dropped week-over-week by more than threshold_pct percentage points " +
    "(default 10). " +
    "Both ops compose existing reports and return the top_n worst rows sorted by absolute shortfall.",
  input: inputSchema,
  async handler(input, ctx) {
    try {
      if (input.kind === 'pacing_underdelivery') {
        return await pacingUnderdelivery(ctx, input.threshold_pct ?? 80, input.top_n);
      }
      return await fillRateDrops(ctx, input.threshold_pct ?? 10, input.top_n);
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

async function pacingUnderdelivery(
  ctx: ToolContext,
  thresholdPct: number,
  topN: number,
) {
  const range = resolveDateRange({ relative: 'month_to_date' }, ctx.timezone, ctx.now);
  // Pro-rated expected delivery: today's day-of-month / total days in month.
  // Pacing % = (impressions / goal) / expected_progress.
  const { daysElapsed, daysInMonth } = monthProgress(range, ctx.timezone, ctx.now);
  const expectedProgress = daysElapsed / daysInMonth;

  const query: ReportQuery = {
    dimensions: ['LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE', 'LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE'],
    metrics: ['IMPRESSIONS'],
    // Restrict to line-item types that have meaningful goals (skip backfill).
    filters: [{
      field: 'LINE_ITEM_TYPE',
      op: 'IN',
      value: ['STANDARD', 'SPONSORSHIP', 'NETWORK', 'BULK', 'PRICE_PRIORITY'],
    }],
  };
  const rows = await runAndRead(ctx, query, range);

  const annotated: Record<string, string>[] = [];
  for (const r of rows) {
    const goal = Number(r.LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE) || 0;
    const imps = Number(r.IMPRESSIONS) || 0;
    if (goal < 1000) continue; // skip tiny / non-goaled line items
    const actualProgress = imps / goal;
    const pacing = expectedProgress === 0 ? 0 : (actualProgress / expectedProgress) * 100;
    if (pacing >= thresholdPct) continue;
    const expectedImps = goal * expectedProgress;
    const shortfall = Math.max(0, Math.round(expectedImps - imps));
    annotated.push({
      LINE_ITEM_ID: r.LINE_ITEM_ID,
      LINE_ITEM_NAME: r.LINE_ITEM_NAME,
      LINE_ITEM_TYPE: r.LINE_ITEM_TYPE,
      goal: String(goal),
      impressions_mtd: String(imps),
      expected_mtd: String(Math.round(expectedImps)),
      shortfall: String(shortfall),
      pacing_pct: pacing.toFixed(1),
    });
  }
  annotated.sort((a, b) => Number(b.shortfall) - Number(a.shortfall));
  const top = annotated.slice(0, topN);
  const summary =
    `Pacing underdelivery (MTD ${range.start}..${range.end}, day ${daysElapsed}/${daysInMonth}, ` +
    `expected ${(expectedProgress * 100).toFixed(0)}%, threshold ${thresholdPct}%): ` +
    `${annotated.length} line items at risk, top ${top.length} returned.`;
  return ctx.output.fromInlineRows(top, summary);
}

async function fillRateDrops(
  ctx: ToolContext,
  thresholdPct: number,
  topN: number,
) {
  const baseRange = resolveDateRange({ relative: 'last_7_days' }, ctx.timezone, ctx.now);
  const prevRange = previousPeriod(baseRange);
  const query: ReportQuery = {
    dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
    metrics: ['AD_REQUESTS', 'IMPRESSIONS'],
  };
  const [base, prev] = await Promise.all([
    runAndRead(ctx, query, baseRange),
    runAndRead(ctx, query, prevRange),
  ]);
  const prevByKey = new Map(prev.map((r) => [r.AD_UNIT_ID, r]));

  const drops: Record<string, string>[] = [];
  for (const b of base) {
    const p = prevByKey.get(b.AD_UNIT_ID);
    if (!p) continue;
    const baseFr = pctOrZero(b.IMPRESSIONS, b.AD_REQUESTS);
    const prevFr = pctOrZero(p.IMPRESSIONS, p.AD_REQUESTS);
    const dropPp = prevFr - baseFr; // positive = fill rate decreased
    if (dropPp < thresholdPct) continue;
    if (Number(b.AD_REQUESTS) < 1000) continue; // skip noise
    drops.push({
      AD_UNIT_ID: b.AD_UNIT_ID,
      AD_UNIT_NAME: b.AD_UNIT_NAME,
      fill_rate_now_pct: baseFr.toFixed(2),
      fill_rate_prev_pct: prevFr.toFixed(2),
      drop_pp: dropPp.toFixed(2),
      ad_requests_now: b.AD_REQUESTS,
      ad_requests_prev: p.AD_REQUESTS,
    });
  }
  drops.sort((a, b) => Number(b.drop_pp) - Number(a.drop_pp));
  const top = drops.slice(0, topN);
  const summary =
    `Fill-rate drops (last 7d ${baseRange.start}..${baseRange.end} vs ` +
    `prev ${prevRange.start}..${prevRange.end}, threshold ≥${thresholdPct}pp drop): ` +
    `${drops.length} ad units flagged, top ${top.length} returned.`;
  return ctx.output.fromInlineRows(top, summary);
}

async function runAndRead(
  ctx: ToolContext,
  query: ReportQuery,
  range: DateRange,
): Promise<Record<string, string>[]> {
  const cached = ctx.reportCache?.get(query, range);
  if (cached) return cached;
  const op = await ctx.client.createReport(query, range);
  const start = Date.now();
  let delay = 2000;
  const timeoutMs = ctx.reportTimeoutMs ?? 300_000;
  while (Date.now() - start < timeoutMs) {
    const s = await ctx.client.pollOperation(op.operation_name);
    if (s.state === 'done') {
      const dest = join(ctx.output.tempDir, `${op.operation_name.replace(/[^\w]/g, '_')}.csv.gz`);
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

function pctOrZero(num: string | undefined, denom: string | undefined): number {
  const n = Number(num) || 0;
  const d = Number(denom) || 0;
  return d === 0 ? 0 : (n / d) * 100;
}

function monthProgress(
  range: { start: string; end: string },
  _timezone: string,
  now: Date | undefined,
): { daysElapsed: number; daysInMonth: number } {
  const today = (now ?? new Date()).toISOString().slice(0, 10);
  const [y, m] = range.start.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const todayDay = Number((today >= range.start ? today : range.end).split('-')[2]);
  return { daysElapsed: Math.max(1, todayDay), daysInMonth };
}

function previousPeriod(r: { start: string; end: string }): DateRange {
  const oneDay = 86_400_000;
  const start = new Date(`${r.start}T00:00:00Z`);
  const end = new Date(`${r.end}T00:00:00Z`);
  const lengthMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - oneDay);
  const prevStart = new Date(prevEnd.getTime() - lengthMs);
  return {
    start: prevStart.toISOString().slice(0, 10),
    end: prevEnd.toISOString().slice(0, 10),
  };
}
