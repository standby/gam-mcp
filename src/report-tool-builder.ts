import { z, type ZodTypeAny } from 'zod';
import { join } from 'node:path';
import { gamError } from './errors.js';
import type { GAMClient, ReportQuery, DateRange } from './gam-client.js';
import type { OutputManager, OutputEnvelope } from './output.js';
import type { ReportCache } from './cache.js';
import type { Logger } from './log.js';
import type { SavedQueryStore } from './saved-queries.js';
import type { UsageCounters } from './usage.js';

export type ToolContext = {
  client: GAMClient;
  output: OutputManager;
  timezone: string;
  logger: Logger;
  now?: Date;
  reportTimeoutMs?: number;
  reportCache?: ReportCache;
  savedQueries?: SavedQueryStore;
  usageCounters?: UsageCounters;
};

export type ToolDefinition<I extends ZodTypeAny> = {
  name: string;
  description: string;
  input: I;
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<OutputEnvelope | { error: unknown }>;
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
      const dateRange = (cfg.buildDateRange?.(input) ??
        (input as { date_range: DateRange }).date_range);

      ctx.logger.debug('report.create', {
        tool: cfg.name,
        dimensions: query.dimensions,
        metrics: query.metrics,
        date_start: dateRange.start,
        date_end: dateRange.end,
      });
      const op = await ctx.client.createReport(query, dateRange);
      const status = await pollUntilDone(
        ctx.client,
        op.operation_name,
        ctx.reportTimeoutMs ?? 300_000,
        ctx.logger,
      );
      if ('error' in status) return status;

      const dest = join(ctx.output.tempDir, `${op.operation_name.replace(/[^\w]/g, '_')}.csv.gz`);
      await ctx.client.downloadReport(status.download_url, dest);
      return ctx.output.fromCsvGzFile(dest, cfg.summary(input));
    },
  };
}

async function pollUntilDone(
  client: GAMClient,
  name: string,
  timeoutMs: number,
  logger: Logger,
): Promise<{ download_url: string } | { error: unknown }> {
  const start = Date.now();
  let delay = 2000;
  while (Date.now() - start < timeoutMs) {
    const s = await client.pollOperation(name);
    const elapsed_ms = Date.now() - start;
    logger.debug('report.poll', { operation: name, state: s.state, elapsed_ms });
    if (s.state === 'done') {
      logger.info('report.done', { operation: name, total_elapsed_ms: elapsed_ms });
      return { download_url: s.download_url };
    }
    if (s.state === 'failed') {
      logger.warn('report.failed', { operation: name, reason: s.reason });
      return gamError('REPORT_FAILED', { reason: s.reason });
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15_000);
  }
  logger.error('report.timeout', { operation: name, timeout_ms: timeoutMs });
  return gamError('REPORT_TIMEOUT', { timeout_ms: timeoutMs });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
