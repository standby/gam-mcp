import { z } from 'zod';
import { gamError } from '../errors.js';
import { resolveDateRange } from '../dates.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { cellText } from '../values.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import type { ReportQuery, DateRange } from '../gam-client.js';

const inputSchema = z.object({
  lookback_days: z.number().int().min(1).max(365).default(30),
  // Strictly-zero is the default "codeless" definition. Raise this to surface
  // "barely used" units too (e.g. min_requests=1000 = "got fewer than 1k
  // requests in a month").
  min_requests: z.number().int().min(0).default(0),
  // Max ad units enumerated from GAM. Pagination through listEntities is
  // transparent, but cap to keep responses bounded.
  max_units: z.number().int().min(1).max(5000).default(1000),
});

export const findUnusedAdUnitsTool: ToolDefinition<typeof inputSchema> = {
  name: 'find_unused_ad_units',
  description:
    'Find "codeless" ad units — those that exist in the network but received fewer than min_requests ad requests over the lookback window. ' +
    'Computes a set-difference between every ad unit in GAM (via listEntities) and ad units that appeared in a Reports run for AD_REQUESTS. ' +
    'GAM reports only emit rows for inventory that had activity, so a missing ad unit means zero requests. ' +
    'Defaults: lookback_days=30 (avoids false positives on seasonally-quiet inventory), min_requests=0 (strict zero), max_units=1000.',
  input: inputSchema,
  async handler(input, ctx: ToolContext) {
    try {
      const range = resolveDateRange(
        { relative: input.lookback_days === 30 ? 'last_30_days' : 'last_7_days' },
        ctx.timezone,
        ctx.now,
      );
      // If caller picked a custom lookback that isn't a canonical relative
      // range, build the explicit window so the report is exact.
      const actualRange = customRange(range, input.lookback_days, ctx.timezone, ctx.now);

      const query: ReportQuery = {
        dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
        metrics: ['AD_REQUESTS'],
      };
      const [allUnits, report] = await Promise.all([
        ctx.client.listEntities({ entity_type: 'ad_unit', limit: input.max_units }),
        executeReportRows(ctx, query, actualRange, 'find_unused_ad_units'),
      ]);
      if ('error' in report) return report;

      const requestsById = new Map<string, number>();
      for (const r of report.rows) {
        const id = cellText(r.AD_UNIT_ID);
        if (!id) continue;
        requestsById.set(id, Number(r.AD_REQUESTS) || 0);
      }

      const unused: Record<string, string>[] = [];
      for (const u of allUnits) {
        const reqs = requestsById.get(String(u.id)) ?? 0;
        if (reqs > input.min_requests) continue;
        unused.push({
          AD_UNIT_ID: String(u.id),
          AD_UNIT_NAME: u.name,
          ad_requests: String(reqs),
        });
      }
      unused.sort((a, b) => Number(a.ad_requests) - Number(b.ad_requests) || a.AD_UNIT_NAME.localeCompare(b.AD_UNIT_NAME));

      const summary =
        `Unused ad units (${actualRange.start}..${actualRange.end}, threshold ≤${input.min_requests} requests): ` +
        `${unused.length} of ${allUnits.length} ad units flagged. ` +
        (allUnits.length === input.max_units
          ? `Hit max_units cap (${input.max_units}) — raise it to scan more.`
          : '');
      const warnings = [...report.warnings];
      if (allUnits.length >= input.max_units) {
        warnings.push(
          `Only the first ${input.max_units} ad units were checked; the network may have more. Raise max_units to check more.`,
        );
      }
      return derivedEnvelope(ctx, {
        summary: summary.trim(),
        inputs: [report.input],
        rows: unused,
        warnings,
      });
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

function customRange(
  baseline: DateRange,
  lookbackDays: number,
  timezone: string,
  now: Date | undefined,
): DateRange {
  if (lookbackDays === 7 || lookbackDays === 30) return baseline;
  // Build [yesterday - (lookback-1) days .. yesterday] in the network tz.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now ?? new Date());
  const [y, m, d] = today.split('-').map(Number);
  const yest = new Date(Date.UTC(y, m - 1, d - 1));
  const start = new Date(yest.getTime() - (lookbackDays - 1) * 86_400_000);
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(yest) };
}
