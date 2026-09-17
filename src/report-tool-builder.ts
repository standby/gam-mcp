import { z, type ZodTypeAny } from 'zod';
import { executeReport } from './report-exec.js';
import type { GAMClient, ReportQuery } from './gam-client.js';
import { rangeRuleFor, resolveDateRange, type DateRangeInput, type ResolvedRange } from './dates.js';
import type { ReportCache } from './cache.js';
import type { Logger } from './log.js';
import type { SavedQueryStore } from './saved-queries.js';
import type { UsageCounters } from './usage.js';
import type { ResultEnvelope } from './envelope.js';
import type { GamErrorEnvelope } from './errors.js';

export type ToolContext = {
  client: GAMClient;
  // The date time zone (GAM_TIMEZONE): what "yesterday" is and how relative
  // ranges resolve (spec §2.4). Recorded as provenance.date_time_zone.
  timezone: string;
  // The network's own zone. GAM computes every report in it (timeZoneSource
  // PUBLISHER); recorded as provenance.report_time_zone.
  reportTimeZone: string;
  // The network's primary currency; every report asks GAM for it.
  currencyCode: string;
  logger: Logger;
  // The network every report and cursor must belong to.
  networkCode: string;
  // Rows per page (GAM_PAGE_ROWS); report-exec clamps it to GAM's maximum.
  pageRows?: number;
  now?: Date;
  reportTimeoutMs?: number;
  // Injected by tests to observe poll delays without waiting.
  sleep?: (ms: number) => Promise<void>;
  // Which GAM result answers each definition, and runs still in progress
  // (spec §2.5, §2.6). Absent: every call runs its report.
  reportCache?: ReportCache;
  savedQueries?: SavedQueryStore;
  usageCounters?: UsageCounters;
};

// The shape for tools that return a nested object rather than report rows.
// `summary` stays required so every tool result opens with one line of
// orientation regardless of shape.
export type JsonEnvelope = { summary: string; [k: string]: unknown };

export type ToolDefinition<I extends ZodTypeAny> = {
  name: string;
  description: string;
  input: I;
  handler: (
    input: z.infer<I>,
    ctx: ToolContext,
  ) => Promise<ResultEnvelope | JsonEnvelope | GamErrorEnvelope>;
};

// A report tool's input always carries a date_range (spec §3.2).
export type ReportToolInput = z.ZodType<{ date_range: DateRangeInput }, z.ZodTypeDef, unknown>;

export type ReportToolConfig<I extends ReportToolInput> = {
  name: string;
  description: string;
  input: I;
  /** Convert validated input to the GAM ReportQuery (dimensions/metrics/filters). */
  buildQuery: (input: z.infer<I>) => ReportQuery;
  /** One line naming what ran, over the resolved and checked range. */
  summary: (input: z.infer<I>, range: ResolvedRange) => string;
  /** Optional caveats about how the returned rows may (not) be read. */
  warnings?: (input: z.infer<I>) => string[] | undefined;
};

// A tool that runs one report over its date_range. The range is resolved
// and checked here, by the rules of the report type the query runs as, so
// no tool built this way can send GAM an unchecked date.
export function buildReportTool<I extends ReportToolInput>(
  cfg: ReportToolConfig<I>,
): ToolDefinition<I> {
  return {
    name: cfg.name,
    description: cfg.description,
    input: cfg.input,
    async handler(input, ctx) {
      const query = cfg.buildQuery(input);
      const range = resolveDateRange(input.date_range, {
        timezone: ctx.timezone,
        now: ctx.now,
        rule: rangeRuleFor(query.report_type),
      });
      if ('error' in range) return range;
      return executeReport(ctx, {
        tool: cfg.name,
        query,
        dateRange: range,
        summary: cfg.summary(input, range),
        warnings: cfg.warnings?.(input) ?? [],
      });
    },
  };
}
