import { z } from 'zod';
import { gamError } from '../errors.js';
import { resolveDateRange } from '../dates.js';
import { validateCombo } from '../schema.js';
import { readCsvGz } from '../output.js';
import { join } from 'node:path';
import type { ToolDefinition } from '../report-tool-builder.js';
import type { GAMClient, ReportQuery, DateRange } from '../gam-client.js';
import type { Logger } from '../log.js';
import { makeKvResolver, maybeRewriteKvFilter } from '../kv-rewrite.js';

const RELATIVE = z.enum([
  'today', 'yesterday', 'last_7_days', 'last_30_days', 'last_week',
  'last_full_month', 'month_to_date', 'quarter_to_date', 'last_quarter', 'year_to_date',
]);

const dateRangeSchema = z.union([
  z.object({ start: z.string(), end: z.string() }),
  z.object({ relative: RELATIVE }),
]);

const filterSchema = z.object({
  field: z.string(),
  // GAM has no EQUALS/NOT_EQUALS — use IN/NOT_IN with a single value (the
  // = / != aliases here translate that). CONTAINS/NOT_CONTAINS do substring
  // match on string fields (e.g., AD_UNIT_NAME CONTAINS "sports").
  op: z.enum(['=', 'IN', '!=', 'CONTAINS', 'NOT_CONTAINS']).default('='),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
});

const inputSchema = z.object({
  dimensions: z.array(z.string()).min(1).max(10),
  metrics: z.array(z.string()).min(1).max(20),
  date_range: dateRangeSchema,
  filters: z.array(filterSchema).optional(),
  // Required when querying CUSTOM_DIMENSION_<N>_VALUE dimensions. Index N in
  // the dimension name maps to index N in this array (i.e., slot 0 = key at
  // index 0). Find IDs via lookup(entity_type='custom_targeting_key').
  custom_dimension_key_ids: z.array(z.number().int().positive()).optional(),
});

export const runReportTool: ToolDefinition<typeof inputSchema> = {
  name: 'run_report',
  description:
    'Run an arbitrary GAM report. Pick dimensions and metrics from describe_schema. Date range accepts absolute {start,end} or {relative: enum}. Returns standard envelope (inline if small, file path if large).',
  input: inputSchema,
  async handler(input, ctx) {
    const comboError = validateCombo({ dimensions: input.dimensions, metrics: input.metrics });
    if (comboError) {
      return gamError('INVALID_INPUT', { reason: comboError, hint: 'Call describe_schema for valid names.' });
    }

    let dateRange;
    try {
      dateRange = resolveDateRange(input.date_range, ctx.timezone, ctx.now);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return gamError('INVALID_DATE_RANGE', { reason: msg });
    }

    let query: ReportQuery = {
      dimensions: input.dimensions,
      metrics: input.metrics,
      filters: input.filters,
      custom_dimension_key_ids: input.custom_dimension_key_ids,
    };
    const warnings: string[] = [];

    // Auto-rewrite KEY_VALUES_NAME='channel_id=479' + AD_REQUESTS (and other
    // request-time metrics) → CUSTOM_DIMENSION slot, since GAM rejects the
    // raw combo. Hidden from the caller's tool call — they get the data and
    // a warning explaining what happened.
    const rewrite = await maybeRewriteKvFilter(query, makeKvResolver(ctx.client));
    if (rewrite.rewritten) {
      query = rewrite.query;
      warnings.push(rewrite.warning);
      ctx.logger.info('report.kv_rewrite', {
        tool: 'run_report',
        warning: rewrite.warning,
      });
    } else if ('error' in rewrite && rewrite.error) {
      return gamError('INVALID_INPUT', {
        reason: rewrite.error,
        hint: 'Discover the key via lookup(entity_type="custom_targeting_key", match="exact") and pass it via custom_dimension_key_ids + CUSTOM_DIMENSION_<N>_VALUE.',
      });
    }

    const summary =
      `Report: dims=[${query.dimensions.join(',')}] metrics=[${query.metrics.join(',')}] ` +
      `${dateRange.start}..${dateRange.end}`;

    // Cache hit: skip create→poll→download entirely.
    const cached = ctx.reportCache?.get(query, dateRange);
    if (cached) return ctx.output.fromInlineRows(cached, `${summary} (cached)`);

    try {
      ctx.logger.debug('report.create', {
        tool: 'run_report',
        dimensions: query.dimensions,
        metrics: query.metrics,
        date_start: dateRange.start,
        date_end: dateRange.end,
      });
      const op = await ctx.client.createReport(query, dateRange);
      const status = await pollUntilDone(ctx.client, op.operation_name, ctx.reportTimeoutMs ?? 300_000, ctx.logger);
      if ('error' in status) return status;
      const dest = join(ctx.output.tempDir, `${op.operation_name.replace(/[^\w]/g, '_')}.csv.gz`);
      await ctx.client.downloadReport(status.download_url, dest);
      // Read once for the cache, then either inline-or-file via output manager.
      // The output manager re-reads the file but on subsequent identical
      // queries the cache short-circuits before we ever hit createReport.
      if (ctx.reportCache) {
        try {
          const { rows } = await readCsvGz(dest);
          ctx.reportCache.set(query, dateRange, rows);
        } catch { /* cache best-effort; envelope path is authoritative */ }
      }
      return ctx.output.fromCsvGzFile(dest, summary, warnings.length ? warnings : undefined);
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

async function pollUntilDone(client: GAMClient, name: string, timeoutMs: number, logger: Logger) {
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
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15_000);
  }
  logger.error('report.timeout', { operation: name, timeout_ms: timeoutMs });
  return gamError('REPORT_TIMEOUT', { timeout_ms: timeoutMs });
}
