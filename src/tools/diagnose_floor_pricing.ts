import { z } from 'zod';
import { gamError } from '../errors.js';
import { num, pct } from '../derived.js';
import { lastDays } from '../dates.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { cellText } from '../values.js';
import { READS_GAM, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

// Floor-pricing verdict per ad unit. GAM's REST reporting API exposes no
// floor / Unified-Pricing-Rule value, so these are INFERRED from the
// relationship between AdX match rate and eCPM relative to the network — not
// a readout of the configured floor.
type Verdict =
  | 'floor_likely_high'  // low match + high eCPM: sacrificing fills for price
  | 'floor_likely_low'   // high match + low eCPM: sacrificing price for fills
  | 'weak_demand'        // low match + low eCPM: not a floor problem
  | 'balanced';          // high match + high eCPM: healthy

const inputSchema = z.object({
  ad_unit_query: z.string().min(1).optional()
    .describe('Substring match on AD_UNIT_NAME to scope the analysis.'),
  ad_unit_ids: z.array(z.number().int().positive()).optional()
    .describe('Restrict to specific ad unit IDs.'),
  lookback_days: z.number().int().min(1).max(90).default(7)
    .describe('Window length in days, ending yesterday.'),
  // Ad units below this AdX request volume are skipped — thin inventory makes
  // match rate / eCPM noisy and the benchmark unstable.
  min_requests: z.number().int().min(0).default(1000)
    .describe('Skip ad units with fewer than this many AdX requests.'),
  top_n: z.number().int().min(1).max(200).default(25)
    .describe('Maximum rows to surface, ranked by estimated opportunity.'),
}).strict();

export const diagnoseFloorPricingTool: ToolDefinition<typeof inputSchema> = {
  name: 'diagnose_floor_pricing',
  description:
    'Diagnose AdX floor-price effectiveness per ad unit by the match-rate × eCPM relationship. ' +
    'Adds the eCPM axis that diagnose_fill_rate lacks, so it can tell apart the two situations that tool collapses into "low_match_rate": ' +
    'floors set too high vs genuinely weak demand. Compares each ad unit to the network median (of qualifying ad units) and emits a verdict: ' +
    '`floor_likely_high` (match rate below median but eCPM above — you are sacrificing fills for price), ' +
    '`floor_likely_low` (match rate above median but eCPM below — sacrificing price for fills), ' +
    '`weak_demand` (both below median — not a floor problem, see diagnose_fill_rate), ' +
    '`balanced` (both at/above median). ' +
    'Each row carries an est_opportunity (publisher currency, UPPER-BOUND estimate) and the raw signals so the verdict is auditable. ' +
    'IMPORTANT: GAM\'s REST reporting API does not expose the actual floor / Unified Pricing Rule value, so this is INFERRED, not a floor readout — ' +
    'confirm against your UPRs in the GAM UI before acting. Scope with ad_unit_query / ad_unit_ids; without either it analyzes network-wide top inventory.',
  input: inputSchema,
  annotations: READS_GAM,
  async handler(input, ctx: ToolContext) {
    try {
      const range = lastDays(input.lookback_days, ctx.timezone, ctx.now);

      const filters: ReportQuery['filters'] = [];
      if (input.ad_unit_query) filters.push({ field: 'AD_UNIT_NAME', op: 'CONTAINS', value: input.ad_unit_query });
      if (input.ad_unit_ids?.length) filters.push({ field: 'AD_UNIT_ID', op: 'IN', value: input.ad_unit_ids });

      const query: ReportQuery = {
        dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
        metrics: [
          'AD_EXCHANGE_TOTAL_REQUESTS',
          'AD_EXCHANGE_MATCH_RATE',
          'AD_EXCHANGE_AVERAGE_ECPM',
          'AD_EXCHANGE_IMPRESSIONS',
          'AD_EXCHANGE_REVENUE',
        ],
        ...(filters.length && { filters }),
      };

      const result = await executeReportRows(ctx, query, range, 'diagnose_floor_pricing');
      if ('error' in result) return result;

      // Qualifying rows: enough AdX volume for a stable signal.
      const qualifying = result.rows
        .map((r) => ({
          id: cellText(r.AD_UNIT_ID),
          name: cellText(r.AD_UNIT_NAME),
          requests: num(r.AD_EXCHANGE_TOTAL_REQUESTS) ?? 0,
          matchRate: num(r.AD_EXCHANGE_MATCH_RATE) ?? 0, // already 0..1
          ecpm: num(r.AD_EXCHANGE_AVERAGE_ECPM) ?? 0,
          impressions: num(r.AD_EXCHANGE_IMPRESSIONS) ?? 0,
          revenue: num(r.AD_EXCHANGE_REVENUE) ?? 0,
        }))
        .filter((r) => r.requests >= input.min_requests);

      if (qualifying.length === 0) {
        return derivedEnvelope(ctx, {
          summary: `Floor-pricing diagnosis (${range.start}..${range.end}): no ad units with >= ${input.min_requests} AdX requests.`,
          inputs: [result.input],
          rows: [],
          // No slicing happened above: qualifying is empty, so the rows
          // handed over already are the whole (empty) total.
          total_row_count: 0,
          warnings: result.warnings,
        });
      }

      // Network benchmark: median of qualifying ad units (robust to outliers).
      const medMatch = median(qualifying.map((r) => r.matchRate));
      const medEcpm = median(qualifying.map((r) => r.ecpm));

      const diagnosed = qualifying.map((r) => {
        const highMatch = r.matchRate >= medMatch;
        const highEcpm = r.ecpm >= medEcpm;
        let verdict: Verdict;
        let opportunity = 0;
        if (!highMatch && highEcpm) {
          verdict = 'floor_likely_high';
          // Revenue from the fills you're not getting, valued conservatively
          // at the network median eCPM (they'd likely clear below this unit's
          // above-median eCPM).
          const unmatched = r.requests * (1 - r.matchRate);
          opportunity = (unmatched / 1000) * medEcpm;
        } else if (highMatch && !highEcpm) {
          verdict = 'floor_likely_low';
          // Upper bound: lifting eCPM to the network median on current
          // impressions (ignores the fill you'd lose by raising the floor).
          opportunity = (r.impressions / 1000) * Math.max(0, medEcpm - r.ecpm);
        } else if (!highMatch && !highEcpm) {
          verdict = 'weak_demand';
        } else {
          verdict = 'balanced';
        }
        return {
          AD_UNIT_ID: r.id,
          AD_UNIT_NAME: r.name,
          verdict,
          est_opportunity: opportunity.toFixed(2),
          adx_match_rate_pct: pct(r.matchRate),
          adx_ecpm: r.ecpm.toFixed(2),
          adx_requests: String(r.requests),
          adx_impressions: String(r.impressions),
          adx_revenue: r.revenue.toFixed(2),
        };
      });

      // Rank by estimated opportunity so the biggest mispricings surface first;
      // balanced / weak_demand rows (opportunity 0) sink.
      diagnosed.sort((a, b) => Number(b.est_opportunity) - Number(a.est_opportunity));
      const top = diagnosed.slice(0, input.top_n);
      const summary =
        `Floor-pricing diagnosis (${range.start}..${range.end}): ${qualifying.length} ad units examined ` +
        `(min_requests=${input.min_requests}; network median match=${pct(medMatch)}%, median eCPM=${medEcpm.toFixed(2)}), ` +
        `top ${top.length} by estimated opportunity. est_opportunity is an upper-bound estimate in publisher currency — ` +
        `floors are inferred from match-rate × eCPM, not read from UPRs.`;
      return derivedEnvelope(ctx, {
        summary,
        inputs: [result.input],
        rows: top,
        total_row_count: diagnosed.length,
        warnings: result.warnings,
      });
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

// Median of a numeric list (returns 0 for empty).
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
