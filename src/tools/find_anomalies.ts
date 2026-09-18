import { z } from 'zod';
import { gamError } from '../errors.js';
import { num, ratio, pct, derived } from '../derived.js';
import { lastDays, previousPeriod, type ResolvedRange } from '../dates.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { cellText } from '../values.js';
import { pacingRows, PACING_LIVE_VALUE_WARNING } from './pacing_status.js';
import { READS_GAM, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

const TOOL = 'find_anomalies';

const inputSchema = z.object({
  kind: z.enum([
    'pacing_underdelivery',
    'fill_rate_drops',
    'ecpm_regression',
    'viewability_drops',
  ]).describe('Which anomaly to look for. Each kind reads threshold_pct in its own unit; see the tool description.'),
  threshold_pct: z.number().min(0).max(100).optional()
    .describe('How far from normal a row must be to be flagged, 0-100, in the unit of the chosen kind. Omit it for the kind\'s default.'),
  top_n: z.number().int().min(1).max(200).default(25)
    .describe('Most rows to return, 1-200, worst first.'),
}).strict();

export const findAnomaliesTool: ToolDefinition<typeof inputSchema> = {
  name: TOOL,
  description:
    "Surface decision-relevant anomalies. Each kind owns its own threshold unit — read carefully. " +
    "kind='pacing_underdelivery': LIFETIME-goal line items (last_7_days) whose GAM delivery_indicator is below " +
    "threshold_pct / 100 (default 80 → flag an indicator below 0.80). Line items with another primary goal type are " +
    "never flagged, because the indicator is only meaningful for a LIFETIME goal. " +
    "kind='fill_rate_drops': ad units whose fill rate dropped week-over-week by more than threshold_pct *percentage points* " +
    "(default 10pp). " +
    "kind='ecpm_regression': buyer networks (DSPs / AdX / AdSense) whose AdX average eCPM dropped week-over-week by more " +
    "than threshold_pct *percent of prior eCPM* (default 15%). Low-volume buyers (<10k AdX imps either side) are filtered. " +
    "kind='viewability_drops': ad units whose Active View viewable-impression rate dropped week-over-week by more than " +
    "threshold_pct *percentage points* (default 5pp). Low-volume ad units (<10k imps either side) are filtered. " +
    "All kinds return the top_n worst rows ranked by severity.",
  input: inputSchema,
  annotations: READS_GAM,
  async handler(input, ctx) {
    try {
      switch (input.kind) {
        case 'pacing_underdelivery':
          return await pacingUnderdelivery(ctx, input.threshold_pct ?? 80, input.top_n);
        case 'fill_rate_drops':
          return await fillRateDrops(ctx, input.threshold_pct ?? 10, input.top_n);
        case 'ecpm_regression':
          return await ecpmRegression(ctx, input.threshold_pct ?? 15, input.top_n);
        case 'viewability_drops':
          return await viewabilityDrops(ctx, input.threshold_pct ?? 5, input.top_n);
      }
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

// find_anomalies' one and only pacing kind: line items whose GAM
// delivery_indicator (live, over last_7_days) says they are under threshold.
// Shares pacingRows() with pacing_status rather than writing the eleven
// dimensions a second time (spec §4.3).
async function pacingUnderdelivery(
  ctx: ToolContext,
  thresholdPct: number,
  topN: number,
) {
  const range = lastDays(7, ctx.timezone, ctx.now);
  const result = await pacingRows(ctx, range, [], TOOL);
  if ('error' in result) return result;

  const threshold = thresholdPct / 100;
  const flagged = result.rows.filter((r) => {
    const indicator = r.delivery_indicator;
    // Only a LIFETIME primary goal has a meaningful indicator; a null
    // indicator (absent from GAM) cannot be compared against the threshold.
    return r.LINE_ITEM_PRIMARY_GOAL_TYPE === 'LIFETIME' && typeof indicator === 'number' && indicator < threshold;
  });
  // Worst first: the lowest indicator is the furthest under pace.
  flagged.sort((a, b) => (a.delivery_indicator as number) - (b.delivery_indicator as number));
  const top = flagged.slice(0, topN);
  const summary =
    `Pacing underdelivery (last 7 days ${range.start}..${range.end}, LIFETIME-goal items with delivery_indicator ` +
    `below ${threshold.toFixed(2)} [threshold_pct=${thresholdPct}]): ${flagged.length} line items at risk, ` +
    `top ${top.length} returned, worst first.`;
  return derivedEnvelope(ctx, {
    summary,
    inputs: [result.input],
    rows: top,
    total_row_count: flagged.length,
    warnings: [...result.warnings, PACING_LIVE_VALUE_WARNING],
    null_input_rows: result.nullInputRows,
  });
}

// lastDays(7, ...) plus the equal-length window immediately before it, as
// fillRateDrops, ecpmRegression and viewabilityDrops all compare.
function weekOverWeek(ctx: ToolContext): { baseRange: ResolvedRange; prevRange: ResolvedRange } {
  const baseRange = lastDays(7, ctx.timezone, ctx.now);
  return { baseRange, prevRange: previousPeriod(baseRange) };
}

const FILL_RATE_DROP_METHOD =
  'Week-over-week drop in fill rate (IMPRESSIONS / AD_REQUESTS), in percentage points, restricted to ad units with ' +
  'at least 1,000 AD_REQUESTS in the current period; flagged when the drop is at least threshold_pct percentage ' +
  'points (default 10). A period whose fill rate cannot be computed (a missing or zero AD_REQUESTS) is never flagged.';

async function fillRateDrops(
  ctx: ToolContext,
  thresholdPct: number,
  topN: number,
) {
  const { baseRange, prevRange } = weekOverWeek(ctx);
  const query: ReportQuery = {
    dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
    metrics: ['AD_REQUESTS', 'IMPRESSIONS'],
  };
  const [base, prev] = await Promise.all([
    executeReportRows(ctx, query, baseRange, TOOL),
    executeReportRows(ctx, query, prevRange, TOOL),
  ]);
  if ('error' in base) return base;
  if ('error' in prev) return prev;
  const prevByKey = new Map(prev.rows.map((r) => [cellText(r.AD_UNIT_ID), r]));

  const drops: { dropPp: number; row: Record<string, unknown> }[] = [];
  let nullInputRows = 0;
  for (const b of base.rows) {
    const p = prevByKey.get(cellText(b.AD_UNIT_ID));
    if (!p) continue;
    const reqNow = num(b.AD_REQUESTS);
    const reqPrev = num(p.AD_REQUESTS);
    const impNow = num(b.IMPRESSIONS);
    const impPrev = num(p.IMPRESSIONS);
    const frNow = ratio(impNow, reqNow);
    const frPrev = ratio(impPrev, reqPrev);
    if (frNow === null || frPrev === null) { nullInputRows++; continue; } // can't compute a drop without both fill rates
    if (reqNow === null || reqNow < 1000) continue; // low-volume noise, not a missing-input case (frNow proved reqNow is a known, nonzero number)
    const dropPp = frPrev * 100 - frNow * 100; // positive = fill rate decreased
    if (dropPp < thresholdPct) continue;
    drops.push({
      dropPp,
      row: {
        AD_UNIT_ID: cellText(b.AD_UNIT_ID),
        AD_UNIT_NAME: cellText(b.AD_UNIT_NAME),
        derived: derived({
          value: Number(dropPp.toFixed(2)),
          method: FILL_RATE_DROP_METHOD,
          heuristic: true,
          inputs: { AD_REQUESTS_now: reqNow, IMPRESSIONS_now: impNow, AD_REQUESTS_prev: reqPrev, IMPRESSIONS_prev: impPrev },
        }),
        fill_rate_now_pct: pct(frNow),
        fill_rate_prev_pct: pct(frPrev),
        ad_requests_now: String(reqNow),
        ad_requests_prev: reqPrev === null ? null : String(reqPrev),
      },
    });
  }
  drops.sort((a, b) => b.dropPp - a.dropPp);
  const top = drops.slice(0, topN).map((d) => d.row);
  const summary =
    `Fill-rate drops (last 7d ${baseRange.start}..${baseRange.end} vs ` +
    `prev ${prevRange.start}..${prevRange.end}, threshold ≥${thresholdPct}pp drop): ` +
    `${drops.length} ad units flagged, top ${top.length} returned.`;
  return derivedEnvelope(ctx, {
    summary,
    inputs: [base.input, prev.input],
    rows: top,
    total_row_count: drops.length,
    warnings: [...base.warnings, ...prev.warnings],
    null_input_rows: nullInputRows,
  });
}

const ECPM_REGRESSION_METHOD =
  'Week-over-week drop in AD_EXCHANGE_AVERAGE_ECPM, as a percent of the prior period\'s eCPM, restricted to buyer ' +
  'networks with at least 10,000 AD_EXCHANGE_IMPRESSIONS on both sides; flagged when the drop is at least ' +
  'threshold_pct percent (default 15). A side whose eCPM or impression count is missing, or whose prior eCPM is ' +
  'zero or negative, is never flagged.';

async function ecpmRegression(
  ctx: ToolContext,
  thresholdPct: number,
  topN: number,
) {
  const { baseRange, prevRange } = weekOverWeek(ctx);
  // AdX-only metrics so we don't dilute named bidders' eCPM with direct-sold revenue.
  // BUYER_NETWORK_NAME slices by demand source (DSP, AdSense, open-auction AdX).
  const query: ReportQuery = {
    dimensions: ['BUYER_NETWORK_NAME'],
    metrics: ['AD_EXCHANGE_IMPRESSIONS', 'AD_EXCHANGE_REVENUE', 'AD_EXCHANGE_AVERAGE_ECPM'],
  };
  const [base, prev] = await Promise.all([
    executeReportRows(ctx, query, baseRange, TOOL),
    executeReportRows(ctx, query, prevRange, TOOL),
  ]);
  if ('error' in base) return base;
  if ('error' in prev) return prev;
  const prevByKey = new Map(prev.rows.map((r) => [cellText(r.BUYER_NETWORK_NAME), r]));

  const regressions: { dropPct: number; row: Record<string, unknown> }[] = [];
  let nullInputRows = 0;
  for (const b of base.rows) {
    const p = prevByKey.get(cellText(b.BUYER_NETWORK_NAME));
    if (!p) continue;
    const baseImps = num(b.AD_EXCHANGE_IMPRESSIONS);
    const prevImps = num(p.AD_EXCHANGE_IMPRESSIONS);
    const baseEcpm = num(b.AD_EXCHANGE_AVERAGE_ECPM);
    const prevEcpm = num(p.AD_EXCHANGE_AVERAGE_ECPM);
    if (baseImps === null || prevImps === null || baseEcpm === null || prevEcpm === null) {
      nullInputRows++;
      continue;
    }
    if (baseImps < 10_000 || prevImps < 10_000) continue; // low-volume noise
    if (prevEcpm <= 0) continue;
    const dropPct = ((prevEcpm - baseEcpm) / prevEcpm) * 100;
    if (dropPct < thresholdPct) continue;
    regressions.push({
      dropPct,
      row: {
        BUYER_NETWORK_NAME: cellText(b.BUYER_NETWORK_NAME),
        derived: derived({
          value: Number(dropPct.toFixed(2)),
          method: ECPM_REGRESSION_METHOD,
          heuristic: true,
          inputs: {
            AD_EXCHANGE_AVERAGE_ECPM_now: baseEcpm,
            AD_EXCHANGE_AVERAGE_ECPM_prev: prevEcpm,
            AD_EXCHANGE_IMPRESSIONS_now: baseImps,
            AD_EXCHANGE_IMPRESSIONS_prev: prevImps,
          },
        }),
        ecpm_now: baseEcpm.toFixed(2),
        ecpm_prev: prevEcpm.toFixed(2),
        adx_impressions_now: String(baseImps),
        adx_impressions_prev: String(prevImps),
        adx_revenue_now: cellText(b.AD_EXCHANGE_REVENUE),
        adx_revenue_prev: cellText(p.AD_EXCHANGE_REVENUE),
      },
    });
  }
  regressions.sort((a, b) => b.dropPct - a.dropPct);
  const top = regressions.slice(0, topN).map((r) => r.row);
  const summary =
    `eCPM regression (last 7d ${baseRange.start}..${baseRange.end} vs ` +
    `prev ${prevRange.start}..${prevRange.end}, threshold ≥${thresholdPct}% AdX-eCPM drop): ` +
    `${regressions.length} buyer networks flagged, top ${top.length} returned.`;
  return derivedEnvelope(ctx, {
    summary,
    inputs: [base.input, prev.input],
    rows: top,
    total_row_count: regressions.length,
    warnings: [...base.warnings, ...prev.warnings],
    null_input_rows: nullInputRows,
  });
}

const VIEWABILITY_DROP_METHOD =
  'Week-over-week drop in ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE, in percentage points, restricted to ad units with ' +
  'at least 10,000 IMPRESSIONS on both sides; flagged when the drop is at least threshold_pct percentage points ' +
  '(default 5). A side whose impressions or viewable rate is missing is never flagged.';

async function viewabilityDrops(
  ctx: ToolContext,
  thresholdPp: number,
  topN: number,
) {
  const { baseRange, prevRange } = weekOverWeek(ctx);
  const query: ReportQuery = {
    dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
    metrics: ['IMPRESSIONS', 'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE'],
  };
  const [base, prev] = await Promise.all([
    executeReportRows(ctx, query, baseRange, TOOL),
    executeReportRows(ctx, query, prevRange, TOOL),
  ]);
  if ('error' in base) return base;
  if ('error' in prev) return prev;
  const prevByKey = new Map(prev.rows.map((r) => [cellText(r.AD_UNIT_ID), r]));

  const drops: { dropPp: number; row: Record<string, unknown> }[] = [];
  let nullInputRows = 0;
  for (const b of base.rows) {
    const p = prevByKey.get(cellText(b.AD_UNIT_ID));
    if (!p) continue;
    const baseImps = num(b.IMPRESSIONS);
    const prevImps = num(p.IMPRESSIONS);
    const rateNow = num(b.ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE);
    const ratePrev = num(p.ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE);
    if (baseImps === null || prevImps === null || rateNow === null || ratePrev === null) {
      nullInputRows++;
      continue;
    }
    if (baseImps < 10_000 || prevImps < 10_000) continue;
    // GAM returns viewable-rate as a 0..1 fraction; render in pp for humans.
    const baseRate = rateNow * 100;
    const prevRate = ratePrev * 100;
    const dropPp = prevRate - baseRate;
    if (dropPp < thresholdPp) continue;
    drops.push({
      dropPp,
      row: {
        AD_UNIT_ID: cellText(b.AD_UNIT_ID),
        AD_UNIT_NAME: cellText(b.AD_UNIT_NAME),
        derived: derived({
          value: Number(dropPp.toFixed(2)),
          method: VIEWABILITY_DROP_METHOD,
          heuristic: true,
          inputs: {
            ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE_now: rateNow,
            ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE_prev: ratePrev,
            IMPRESSIONS_now: baseImps,
            IMPRESSIONS_prev: prevImps,
          },
        }),
        viewability_now_pct: baseRate.toFixed(2),
        viewability_prev_pct: prevRate.toFixed(2),
        impressions_now: String(baseImps),
        impressions_prev: String(prevImps),
      },
    });
  }
  drops.sort((a, b) => b.dropPp - a.dropPp);
  const top = drops.slice(0, topN).map((d) => d.row);
  const summary =
    `Viewability drops (last 7d ${baseRange.start}..${baseRange.end} vs ` +
    `prev ${prevRange.start}..${prevRange.end}, threshold ≥${thresholdPp}pp viewable-rate drop): ` +
    `${drops.length} ad units flagged, top ${top.length} returned.`;
  return derivedEnvelope(ctx, {
    summary,
    inputs: [base.input, prev.input],
    rows: top,
    total_row_count: drops.length,
    warnings: [...base.warnings, ...prev.warnings],
    null_input_rows: nullInputRows,
  });
}
