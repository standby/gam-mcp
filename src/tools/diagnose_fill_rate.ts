import { z } from 'zod';
import { gamError } from '../errors.js';
import { num, ratio, pct, derived } from '../derived.js';
import { lastDays, previousPeriod } from '../dates.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { cellText, type Cell } from '../values.js';
import { READS_GAM, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

// Diagnostic vocabulary the tool emits. Single primary cause per row — the
// rule order in `diagnose()` matters because multiple thresholds can match
// at once (e.g. tag_integration trivially satisfies the low_match_rate
// floor). First match wins — deeper-funnel causes are checked first — and a
// rule that can't be evaluated because one of its inputs is missing makes
// the whole verdict null rather than falling through to the next rule.
type Cause =
  | 'healthy'
  | 'tag_integration'
  | 'demand_collapse'
  | 'low_match_rate'
  | 'direct_underdelivery'
  | 'no_demand'
  | 'mixed';

// Fixed across every row: §4.6 wants the rule and its thresholds *stated*,
// not just implied by the cause label. One module-level constant keeps that
// statement identical across rows instead of re-derived per row.
const FILL_RATE_METHOD =
  'First matching rule over the AdX funnel, in priority order: healthy if IMPRESSIONS / AD_REQUESTS >= 0.85; ' +
  'tag_integration if AD_EXCHANGE_TOTAL_REQUESTS / AD_REQUESTS < 0.10; demand_collapse if AD_EXCHANGE_MATCH_RATE ' +
  'dropped by >= 0.10 versus the comparison period; low_match_rate if AD_EXCHANGE_MATCH_RATE < 0.30; ' +
  'direct_underdelivery if AD_SERVER_RESPONSES_SERVED / AD_REQUESTS < 0.20; no_demand if UNFILLED_IMPRESSIONS / ' +
  'AD_REQUESTS > 0.50; otherwise mixed; null when the next rule that would need to run has a missing input.';

const inputSchema = z.object({
  ad_unit_query: z.string().min(1).optional()
    .describe('Only ad units whose name contains this text.'),
  ad_unit_ids: z.array(z.number().int().positive()).optional()
    .describe('Only these ad units.'),
  lookback_days: z.number().int().min(1).max(90).default(7)
    .describe('How many complete days, ending yesterday, to diagnose, 1-90.'),
  comparison: z.enum(['previous_period', 'none']).default('previous_period')
    .describe('"previous_period" also reads the same number of days just before, which the demand_collapse cause needs; "none" skips it.'),
  top_n: z.number().int().min(1).max(200).default(25)
    .describe('Most ad units to return, 1-200.'),
  // Skip ad units with fewer than this many AD_REQUESTS over the window —
  // brand-new or near-dormant inventory creates noisy "fill 0%" rows.
  min_requests: z.number().int().min(0).default(1000)
    .describe('Skip ad units with fewer ad requests than this in the window.'),
}).strict();

export const diagnoseFillRateTool: ToolDefinition<typeof inputSchema> = {
  name: 'diagnose_fill_rate',
  description:
    'Diagnose WHY ad units have low fill rate. Runs the AdX funnel report for the window (and optionally the previous period), ' +
    'then attributes a single primary cause per ad unit as derived.value (derived.method states the rule; derived.inputs ' +
    'carries every funnel value used, including IMPRESSIONS): ' +
    '`healthy` (fill ≥85%), ' +
    '`tag_integration` (very few requests reach AdX — tag misconfigured or ad unit is direct-only), ' +
    '`demand_collapse` (AdX match rate dropped ≥10pp WoW — requires comparison), ' +
    '`low_match_rate` (absolute AdX match rate <30% — floors too high or weak buyer demand), ' +
    '`direct_underdelivery` (ad-server response rate <20% — direct line items not targeting this inventory), ' +
    '`no_demand` (unfilled rate >50% with healthy AdX request volume — no buyer interest at any tier), ' +
    '`mixed` (no single rule dominates), or ' +
    'null (a rule that would need to run has a missing input — e.g. no AD_REQUESTS reported — rather than a guess). ' +
    'Filter by ad_unit_query (substring on AD_UNIT_NAME) or ad_unit_ids; without either, the tool diagnoses the network-wide top offenders ranked by unfilled-impression volume. ' +
    'Each row carries the supporting funnel ratios so the attribution is auditable.',
  input: inputSchema,
  annotations: READS_GAM,
  async handler(input, ctx: ToolContext) {
    try {
      const baseRange = lastDays(input.lookback_days, ctx.timezone, ctx.now);
      const prevRange = input.comparison === 'previous_period' ? previousPeriod(baseRange) : null;

      const filters: ReportQuery['filters'] = [];
      if (input.ad_unit_query) filters.push({ field: 'AD_UNIT_NAME', op: 'CONTAINS', value: input.ad_unit_query });
      if (input.ad_unit_ids?.length) filters.push({ field: 'AD_UNIT_ID', op: 'IN', value: input.ad_unit_ids });

      const query: ReportQuery = {
        dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
        // Order chosen so the funnel reads top-to-bottom:
        // requests → routed to AdX → AdX match → ad-server response → unfilled → final fill (IMPRESSIONS).
        metrics: [
          'AD_REQUESTS',
          'AD_EXCHANGE_TOTAL_REQUESTS',
          'AD_EXCHANGE_MATCH_RATE',
          'AD_SERVER_RESPONSES_SERVED',
          'UNFILLED_IMPRESSIONS',
          'IMPRESSIONS',
        ],
        ...(filters.length && { filters }),
      };

      const [base, prev] = await Promise.all([
        executeReportRows(ctx, query, baseRange, 'diagnose_fill_rate'),
        prevRange ? executeReportRows(ctx, query, prevRange, 'diagnose_fill_rate') : Promise.resolve(null),
      ]);
      if ('error' in base) return base;
      if (prev && 'error' in prev) return prev;
      const prevByKey = new Map((prev?.rows ?? []).map((r) => [cellText(r.AD_UNIT_ID), r]));

      const diagnosed: { unfilled: number | null; row: Record<string, unknown> }[] = [];
      let nullInputRows = 0;
      for (const r of base.rows) {
        const requests = num(r.AD_REQUESTS);
        // An unknown request count is not known to be *below* min_requests
        // -- filtering only drops a row whose count is known and too small.
        // A missing count falls through to diagnosis instead, where it
        // surfaces honestly as derived.value: null rather than being
        // silently dropped as if it were noise.
        if (requests !== null && requests < input.min_requests) continue;

        const f = funnel(r);
        const prevRow = prevByKey.get(cellText(r.AD_UNIT_ID));
        const prevF = prevRow ? funnel(prevRow) : null;
        const cause = diagnose(f, prevF);
        if (cause === null) nullInputRows++;

        const inputs: Record<string, unknown> = {
          AD_REQUESTS: f.requests,
          AD_EXCHANGE_TOTAL_REQUESTS: f.adxRequests,
          AD_EXCHANGE_MATCH_RATE: f.adxMatchRate,
          AD_SERVER_RESPONSES_SERVED: f.responses,
          UNFILLED_IMPRESSIONS: f.unfilled,
          IMPRESSIONS: f.impressions,
        };
        if (prevF) inputs.AD_EXCHANGE_MATCH_RATE_PREV = prevF.adxMatchRate;

        diagnosed.push({
          unfilled: f.unfilled,
          row: {
            AD_UNIT_ID: cellText(r.AD_UNIT_ID),
            AD_UNIT_NAME: cellText(r.AD_UNIT_NAME),
            derived: derived({ value: cause, method: FILL_RATE_METHOD, heuristic: true, inputs }),
            fill_rate_pct: f.fillRate === null ? null : pct(f.fillRate),
            ...(prevF && {
              fill_rate_prev_pct: prevF.fillRate === null ? null : pct(prevF.fillRate),
              fill_rate_drop_pp: f.fillRate === null || prevF.fillRate === null
                ? null
                : (prevF.fillRate * 100 - f.fillRate * 100).toFixed(2),
            }),
            adx_request_share_pct: f.adxRequestShare === null ? null : pct(f.adxRequestShare),
            adx_match_rate_pct: f.adxMatchRate === null ? null : pct(f.adxMatchRate),
            ...(prevF && { adx_match_rate_prev_pct: prevF.adxMatchRate === null ? null : pct(prevF.adxMatchRate) }),
            direct_response_share_pct: f.directResponseShare === null ? null : pct(f.directResponseShare),
            unfilled_share_pct: f.unfilledShare === null ? null : pct(f.unfilledShare),
            ad_requests: f.requests === null ? null : String(f.requests),
            unfilled_impressions: f.unfilled === null ? null : String(f.unfilled),
          },
        });
      }

      // Impact-aware ranking: highest unfilled-impression count first. A row
      // whose unfilled count is unknown sinks below every known count,
      // including a genuine zero -- it is never treated as if it were zero.
      diagnosed.sort((a, b) => sortKey(b.unfilled) - sortKey(a.unfilled));
      const top = diagnosed.slice(0, input.top_n).map((d) => d.row);
      const cmpDesc = prevRange ? ` vs prev ${prevRange.start}..${prevRange.end}` : ' (no comparison)';
      const summary =
        `Fill-rate diagnosis (${baseRange.start}..${baseRange.end}${cmpDesc}): ` +
        `${diagnosed.length} ad units examined (min_requests=${input.min_requests}), top ${top.length} by unfilled-impression volume.`;
      return derivedEnvelope(ctx, {
        summary,
        inputs: prev ? [base.input, prev.input] : [base.input],
        rows: top,
        total_row_count: diagnosed.length,
        warnings: [...base.warnings, ...(prev?.warnings ?? [])],
        null_input_rows: nullInputRows,
      });
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

// --------------------------- diagnosis rules ---------------------------

type Funnel = {
  requests: number | null;              // AD_REQUESTS
  adxRequests: number | null;           // AD_EXCHANGE_TOTAL_REQUESTS
  adxMatchRate: number | null;          // AD_EXCHANGE_MATCH_RATE (already 0..1)
  responses: number | null;             // AD_SERVER_RESPONSES_SERVED
  unfilled: number | null;              // UNFILLED_IMPRESSIONS
  impressions: number | null;           // IMPRESSIONS
  adxRequestShare: number | null;       // adxRequests / requests
  directResponseShare: number | null;   // responses / requests
  unfilledShare: number | null;         // unfilled / requests
  fillRate: number | null;              // impressions / requests
};

function funnel(r: Record<string, Cell>): Funnel {
  const requests = num(r.AD_REQUESTS);
  const adxRequests = num(r.AD_EXCHANGE_TOTAL_REQUESTS);
  const responses = num(r.AD_SERVER_RESPONSES_SERVED);
  const unfilled = num(r.UNFILLED_IMPRESSIONS);
  const impressions = num(r.IMPRESSIONS);
  return {
    requests,
    adxRequests,
    adxMatchRate: num(r.AD_EXCHANGE_MATCH_RATE),
    responses,
    unfilled,
    impressions,
    adxRequestShare: ratio(adxRequests, requests),
    directResponseShare: ratio(responses, requests),
    unfilledShare: ratio(unfilled, requests),
    fillRate: ratio(impressions, requests),
  };
}

// First match wins. Order chosen so deeper-funnel / more-specific causes
// take precedence over generic ones — e.g. `tag_integration` (request never
// reaches AdX) is checked before `low_match_rate` (AdX gets the request but
// can't match), because the former trivially produces the latter. A rule
// whose own input is missing can't be evaluated, and none of the rules
// below it can be trusted to be "not triggered" either -- so the whole
// verdict is null rather than falling through past what couldn't be tested.
function diagnose(now: Funnel, prev: Funnel | null): Cause | null {
  if (now.fillRate === null) return null;
  if (now.fillRate >= 0.85) return 'healthy';
  if (now.adxRequestShare === null) return null;
  if (now.adxRequestShare < 0.10) return 'tag_integration';
  if (prev && prev.adxMatchRate !== null && now.adxMatchRate !== null &&
      prev.adxMatchRate - now.adxMatchRate >= 0.10) return 'demand_collapse';
  if (now.adxMatchRate === null) return null;
  if (now.adxMatchRate < 0.30) return 'low_match_rate';
  if (now.directResponseShare === null) return null;
  if (now.directResponseShare < 0.20) return 'direct_underdelivery';
  if (now.unfilledShare === null) return null;
  if (now.unfilledShare > 0.50) return 'no_demand';
  return 'mixed';
}

// Ranking key for a nullable count: unknown sinks below every known count,
// including a genuine zero, without pretending the unknown count *is* zero.
function sortKey(x: number | null): number {
  return x === null ? -1 : x;
}
