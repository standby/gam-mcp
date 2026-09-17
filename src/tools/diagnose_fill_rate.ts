import { z } from 'zod';
import { gamError } from '../errors.js';
import { numOr0, pct } from '../report-run.js';
import { lastDays, previousPeriod } from '../dates.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { cellText, type Cell } from '../values.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

// Diagnostic vocabulary the tool emits. Single primary cause per row — the
// rule order in `diagnose()` matters because multiple thresholds can match
// at once (e.g. tag_integration trivially satisfies the low_match_rate
// floor). First match wins; deeper-funnel causes are checked first.
type Cause =
  | 'healthy'
  | 'tag_integration'
  | 'demand_collapse'
  | 'low_match_rate'
  | 'direct_underdelivery'
  | 'no_demand'
  | 'mixed';

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
    'then attributes a single primary cause per ad unit: ' +
    '`healthy` (fill ≥85%), ' +
    '`tag_integration` (very few requests reach AdX — tag misconfigured or ad unit is direct-only), ' +
    '`demand_collapse` (AdX match rate dropped ≥10pp WoW — requires comparison), ' +
    '`low_match_rate` (absolute AdX match rate <30% — floors too high or weak buyer demand), ' +
    '`direct_underdelivery` (ad-server response rate <20% — direct line items not targeting this inventory), ' +
    '`no_demand` (unfilled rate >50% with healthy AdX request volume — no buyer interest at any tier), ' +
    '`mixed` (no single rule dominates). ' +
    'Filter by ad_unit_query (substring on AD_UNIT_NAME) or ad_unit_ids; without either, the tool diagnoses the network-wide top offenders ranked by unfilled-impression volume. ' +
    'Each row carries the supporting funnel ratios so the attribution is auditable.',
  input: inputSchema,
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
        // requests → routed to AdX → AdX match → ad-server response → unfilled → final fill.
        metrics: [
          'AD_REQUESTS',
          'AD_EXCHANGE_TOTAL_REQUESTS',
          'AD_EXCHANGE_MATCH_RATE',
          'AD_SERVER_RESPONSES_SERVED',
          'UNFILLED_IMPRESSIONS',
          'FILL_RATE',
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

      const diagnosed: Record<string, string>[] = [];
      for (const r of base.rows) {
        const requests = numOr0(r.AD_REQUESTS);
        if (requests < input.min_requests) continue;

        const f = funnel(r);
        const prevRow = prevByKey.get(cellText(r.AD_UNIT_ID));
        const prevF = prevRow ? funnel(prevRow) : null;
        const cause = diagnose(f, prevF);

        diagnosed.push({
          AD_UNIT_ID: cellText(r.AD_UNIT_ID),
          AD_UNIT_NAME: cellText(r.AD_UNIT_NAME),
          cause,
          fill_rate_pct: pct(f.fillRate),
          ...(prevF && {
            fill_rate_prev_pct: pct(prevF.fillRate),
            fill_rate_drop_pp: (prevF.fillRate * 100 - f.fillRate * 100).toFixed(2),
          }),
          adx_request_share_pct: pct(f.adxRequestShare),
          adx_match_rate_pct: pct(f.adxMatchRate),
          ...(prevF && { adx_match_rate_prev_pct: pct(prevF.adxMatchRate) }),
          direct_response_share_pct: pct(f.directResponseShare),
          unfilled_share_pct: pct(f.unfilledShare),
          ad_requests: String(requests),
          unfilled_impressions: String(numOr0(r.UNFILLED_IMPRESSIONS)),
        });
      }

      // Impact-aware ranking: highest unfilled-impression count first. Healthy
      // rows naturally sink because their unfilled count is low.
      diagnosed.sort((a, b) => Number(b.unfilled_impressions) - Number(a.unfilled_impressions));
      const top = diagnosed.slice(0, input.top_n);
      const cmpDesc = prevRange ? ` vs prev ${prevRange.start}..${prevRange.end}` : ' (no comparison)';
      const summary =
        `Fill-rate diagnosis (${baseRange.start}..${baseRange.end}${cmpDesc}): ` +
        `${diagnosed.length} ad units examined (min_requests=${input.min_requests}), top ${top.length} by unfilled-impression volume.`;
      return derivedEnvelope(ctx, {
        summary,
        inputs: prev ? [base.input, prev.input] : [base.input],
        rows: top,
        warnings: [...base.warnings, ...(prev?.warnings ?? [])],
      });
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

// --------------------------- diagnosis rules ---------------------------

type Funnel = {
  requests: number;
  adxRequestShare: number;     // AD_EXCHANGE_TOTAL_REQUESTS / AD_REQUESTS
  adxMatchRate: number;        // AD_EXCHANGE_MATCH_RATE (already 0..1)
  directResponseShare: number; // AD_SERVER_RESPONSES_SERVED / AD_REQUESTS
  unfilledShare: number;       // UNFILLED_IMPRESSIONS / AD_REQUESTS
  fillRate: number;            // FILL_RATE (already 0..1)
};

function funnel(r: Record<string, Cell>): Funnel {
  const requests = numOr0(r.AD_REQUESTS);
  const adxReq = numOr0(r.AD_EXCHANGE_TOTAL_REQUESTS);
  const responses = numOr0(r.AD_SERVER_RESPONSES_SERVED);
  const unfilled = numOr0(r.UNFILLED_IMPRESSIONS);
  return {
    requests,
    adxRequestShare: requests === 0 ? 0 : adxReq / requests,
    adxMatchRate: numOr0(r.AD_EXCHANGE_MATCH_RATE),
    directResponseShare: requests === 0 ? 0 : responses / requests,
    unfilledShare: requests === 0 ? 0 : unfilled / requests,
    fillRate: numOr0(r.FILL_RATE),
  };
}

// First match wins. Order chosen so deeper-funnel / more-specific causes
// take precedence over generic ones — e.g. `tag_integration` (request never
// reaches AdX) is checked before `low_match_rate` (AdX gets the request but
// can't match), because the former trivially produces the latter.
function diagnose(now: Funnel, prev: Funnel | null): Cause {
  if (now.fillRate >= 0.85) return 'healthy';
  if (now.adxRequestShare < 0.10) return 'tag_integration';
  if (prev && prev.adxMatchRate - now.adxMatchRate >= 0.10) return 'demand_collapse';
  if (now.adxMatchRate < 0.30) return 'low_match_rate';
  if (now.directResponseShare < 0.20) return 'direct_underdelivery';
  if (now.unfilledShare > 0.50) return 'no_demand';
  return 'mixed';
}
