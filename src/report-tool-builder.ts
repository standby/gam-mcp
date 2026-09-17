import { z, type ZodTypeAny } from 'zod';
import { executeReport } from './report-exec.js';
import type { GAMClient, ReportQuery, DateRange } from './gam-client.js';
import type { OutputManager, OutputEnvelope } from './output.js';
import type { ReportCache } from './cache.js';
import type { Logger } from './log.js';
import type { SavedQueryStore } from './saved-queries.js';
import type { UsageCounters } from './usage.js';
import type { ResultEnvelope } from './envelope.js';
import type { GamErrorEnvelope } from './errors.js';

export type ToolContext = {
  client: GAMClient;
  timezone: string;
  logger: Logger;
  // The network every report and cursor must belong to.
  networkCode: string;
  // Rows per page (GAM_PAGE_ROWS); report-exec clamps it to GAM's maximum.
  pageRows?: number;
  now?: Date;
  reportTimeoutMs?: number;
  // Injected by tests to observe poll delays without waiting.
  sleep?: (ms: number) => Promise<void>;
  // Not used by the report path until the cache is rebuilt (0.6.0 PR 2).
  reportCache?: ReportCache;
  savedQueries?: SavedQueryStore;
  usageCounters?: UsageCounters;
  // Legacy; removed once every tool uses envelope.ts.
  output?: OutputManager;
};

// Tools that return a nested configuration object rather than report rows
// return this instead of an OutputEnvelope (whose rows are flat strings).
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
  ) => Promise<ResultEnvelope | OutputEnvelope | JsonEnvelope | GamErrorEnvelope>;
};

export type ReportToolConfig<I extends ZodTypeAny> = {
  name: string;
  description: string;
  input: I;
  /** Convert validated input to the GAM ReportQuery (dimensions/metrics/filters). */
  buildQuery: (input: z.infer<I>) => ReportQuery;
  /** Convert validated input to a date range. Defaults to using `input.date_range`. */
  buildDateRange?: (input: z.infer<I>) => DateRange;
  /** Build the human-readable summary string returned in the envelope. */
  summary: (input: z.infer<I>) => string;
  /** Optional caveats about how the returned rows may (not) be read. */
  warnings?: (input: z.infer<I>) => string[] | undefined;
};

export function buildReportTool<I extends ZodTypeAny>(
  cfg: ReportToolConfig<I>,
): ToolDefinition<I> {
  return {
    name: cfg.name,
    description: cfg.description,
    input: cfg.input,
    async handler(input, ctx) {
      const query = cfg.buildQuery(input);
      const dateRange = cfg.buildDateRange?.(input) ?? (input as { date_range: DateRange }).date_range;
      return executeReport(ctx, {
        query,
        dateRange,
        summary: cfg.summary(input),
        warnings: cfg.warnings?.(input) ?? [],
      });
    },
  };
}
