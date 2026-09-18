import { z } from 'zod';
import { gamError } from '../errors.js';
import { num, pct, derived } from '../derived.js';
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

// est_opportunity is an estimate, and which of the two formulas applies
// depends on the verdict -- so the method that names the formula is chosen
// per row, not one constant reused everywhere (spec §4.6).
const FLOOR_METHOD_HIGH =
  'est_opportunity is an upper-bound estimate in publisher currency for floor_likely_high: ' +
  "(AD_EXCHANGE_TOTAL_REQUESTS * (1 - AD_EXCHANGE_MATCH_RATE) / 1000) * the network median eCPM -- the unmatched " +
  "requests' fills, valued conservatively at the median rather than this ad unit's own above-median eCPM. Verdict " +
  'rule: AD_EXCHANGE_MATCH_RATE below the network median with AD_EXCHANGE_AVERAGE_ECPM at/above it. Floors are ' +
  "inferred from match-rate x eCPM, not read from GAM's Unified Pricing Rules.";
const FLOOR_METHOD_LOW =
  'est_opportunity is an upper-bound estimate in publisher currency for floor_likely_low: ' +
  '(AD_EXCHANGE_IMPRESSIONS / 1000) * max(0, network median eCPM - AD_EXCHANGE_AVERAGE_ECPM) -- lifting eCPM to ' +
  'the median on current impressions, ignoring the fill that would be lost by raising the floor. Verdict rule: ' +
  'AD_EXCHANGE_MATCH_RATE at/above the network median with AD_EXCHANGE_AVERAGE_ECPM below it. Floors are inferred ' +
  "from match-rate x eCPM, not read from GAM's Unified Pricing Rules.";
const FLOOR_METHOD_NEUTRAL =
  'est_opportunity is 0: AD_EXCHANGE_MATCH_RATE and AD_EXCHANGE_AVERAGE_ECPM are on the same side of the network ' +
  'median (weak_demand: both below; balanced: both at/above), so this is not read as a floor-pricing mispricing. ' +
  "Floors are inferred from match-rate x eCPM, not read from GAM's Unified Pricing Rules.";
const FLOOR_METHOD_MISSING =
  'est_opportunity cannot be computed: a floor-pricing verdict needs both AD_EXCHANGE_MATCH_RATE and ' +
  'AD_EXCHANGE_AVERAGE_ECPM, and GAM did not report at least one of them for this ad unit.';

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
    '`balanced` (both at/above median), or ' +
    'null (AdX match rate or eCPM was not reported for this ad unit — no verdict is guessed). ' +
    'Each row carries derived.value (est_opportunity, publisher currency, UPPER-BOUND estimate), derived.method naming ' +
    'which formula was used, derived.inputs, and the raw signals so the verdict is auditable. ' +
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

      const candidates = result.rows.map((r) => ({
        id: cellText(r.AD_UNIT_ID),
        name: cellText(r.AD_UNIT_NAME),
        requests: num(r.AD_EXCHANGE_TOTAL_REQUESTS),
        matchRate: num(r.AD_EXCHANGE_MATCH_RATE), // already 0..1
        ecpm: num(r.AD_EXCHANGE_AVERAGE_ECPM),
        impressions: num(r.AD_EXCHANGE_IMPRESSIONS),
        revenue: num(r.AD_EXCHANGE_REVENUE),
      }));

      // Qualifying: enough AdX volume for a stable signal. An unknown
      // request count is not known to meet that bar, so it doesn't qualify.
      const qualifying = candidates.filter(
        (r): r is typeof r & { requests: number } => r.requests !== null && r.requests >= input.min_requests,
      );

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

      // Network benchmark: median match rate / eCPM across qualifying ad
      // units that actually reported the signal. A row's own missing match
      // rate or eCPM is excluded from the benchmark, not folded in as 0.
      const medMatch = median(qualifying.map((r) => r.matchRate).filter((x): x is number => x !== null));
      const medEcpm = median(qualifying.map((r) => r.ecpm).filter((x): x is number => x !== null));

      // Every row's outcome (verdict, opportunity, method) is decided first,
      // in one place, then turned into a row and counted from that outcome --
      // not from a second, separately-maintained list of "which inputs are
      // required" predicates. Two different formulas need different inputs
      // (floor_likely_low alone needs AD_EXCHANGE_IMPRESSIONS on top of match
      // rate/eCPM), so a hand-maintained predicate list drifts the moment a
      // new way to produce a null value is added; reading the count off
      // opportunity === null cannot drift, because that's the same value the
      // row's own derived.value is built from.
      const items = qualifying.map((r) => {
        let verdict: Verdict | null;
        let opportunity: number | null;
        let method: string;

        if (r.matchRate === null || r.ecpm === null) {
          verdict = null;
          opportunity = null;
          method = FLOOR_METHOD_MISSING;
        } else {
          const matchRate = r.matchRate;
          const ecpm = r.ecpm;
          const highMatch = matchRate >= medMatch;
          const highEcpm = ecpm >= medEcpm;
          if (!highMatch && highEcpm) {
            verdict = 'floor_likely_high';
            method = FLOOR_METHOD_HIGH;
            // Revenue from the fills you're not getting, valued conservatively
            // at the network median eCPM (they'd likely clear below this unit's
            // above-median eCPM).
            const unmatched = r.requests * (1 - matchRate);
            opportunity = (unmatched / 1000) * medEcpm;
          } else if (highMatch && !highEcpm) {
            verdict = 'floor_likely_low';
            method = FLOOR_METHOD_LOW;
            // Upper bound: lifting eCPM to the network median on current
            // impressions (ignores the fill you'd lose by raising the floor).
            // Needs AD_EXCHANGE_IMPRESSIONS, which -- unlike match rate/eCPM --
            // isn't required to reach a verdict, only to size this estimate.
            opportunity = r.impressions === null ? null : (r.impressions / 1000) * Math.max(0, medEcpm - ecpm);
          } else if (!highMatch && !highEcpm) {
            verdict = 'weak_demand';
            method = FLOOR_METHOD_NEUTRAL;
            opportunity = 0;
          } else {
            verdict = 'balanced';
            method = FLOOR_METHOD_NEUTRAL;
            opportunity = 0;
          }
        }

        return {
          opp: opportunity,
          row: {
            AD_UNIT_ID: r.id,
            AD_UNIT_NAME: r.name,
            verdict,
            derived: derived({
              value: opportunity === null ? null : Number(opportunity.toFixed(2)),
              method,
              heuristic: true,
              inputs: {
                AD_EXCHANGE_TOTAL_REQUESTS: r.requests,
                AD_EXCHANGE_MATCH_RATE: r.matchRate,
                AD_EXCHANGE_AVERAGE_ECPM: r.ecpm,
                AD_EXCHANGE_IMPRESSIONS: r.impressions,
                network_median_match_rate: medMatch,
                network_median_ecpm: medEcpm,
              },
            }),
            adx_match_rate_pct: r.matchRate === null ? null : pct(r.matchRate),
            adx_ecpm: r.ecpm === null ? null : r.ecpm.toFixed(2),
            adx_requests: String(r.requests),
            adx_impressions: r.impressions === null ? null : String(r.impressions),
            adx_revenue: r.revenue === null ? null : r.revenue.toFixed(2),
          },
        };
      });
      // Counted from the outcome, once per row: exactly the rows whose
      // derived.value came out null because an input was missing.
      const nullInputRows = items.filter((i) => i.opp === null).length;

      // Rank by estimated opportunity so the biggest mispricings surface
      // first; balanced/weak_demand rows (opportunity 0) sink, and rows
      // whose opportunity couldn't be computed sink below even those.
      items.sort((a, b) => sortKey(b.opp) - sortKey(a.opp));
      const top = items.slice(0, input.top_n).map((i) => i.row);
      const summary =
        `Floor-pricing diagnosis (${range.start}..${range.end}): ${qualifying.length} ad units examined ` +
        `(min_requests=${input.min_requests}; network median match=${pct(medMatch)}%, median eCPM=${medEcpm.toFixed(2)}), ` +
        `top ${top.length} by estimated opportunity. est_opportunity is an upper-bound estimate in publisher currency — ` +
        `floors are inferred from match-rate × eCPM, not read from UPRs.`;
      return derivedEnvelope(ctx, {
        summary,
        inputs: [result.input],
        rows: top,
        total_row_count: items.length,
        warnings: result.warnings,
        null_input_rows: nullInputRows,
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

// Ranking key for a nullable opportunity: unknown sinks below every known
// value, including a genuine 0, without pretending the unknown value is 0.
function sortKey(x: number | null): number {
  return x === null ? -1 : x;
}
