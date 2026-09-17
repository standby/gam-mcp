import { z } from 'zod';
import { gamError } from '../errors.js';
import { lastDays } from '../dates.js';
import { executeReportRows, derivedEnvelope } from '../report-exec.js';
import { cellText } from '../values.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

const inputSchema = z.object({
  lookback_days: z.number().int().min(1).max(365).default(30)
    .describe('How many complete days, ending yesterday, to count ad requests over, 1-365.'),
  // Strictly-zero is the default "codeless" definition. Raise this to surface
  // "barely used" units too (e.g. min_requests=1000 = "got fewer than 1k
  // requests in a month").
  min_requests: z.number().int().min(0).default(0)
    .describe('Flag ad units with at most this many ad requests in the window; 0 means none at all.'),
  // Max ad units enumerated from GAM. Pagination through listEntities is
  // transparent, but cap to keep responses bounded.
  max_units: z.number().int().min(1).max(5000).default(1000)
    .describe('Most ad units to read from the network, 1-5000.'),
}).strict();

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
      const actualRange = lastDays(input.lookback_days, ctx.timezone, ctx.now);

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
