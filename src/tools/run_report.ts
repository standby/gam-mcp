import { z } from 'zod';
import { gamError } from '../errors.js';
import { resolveDateRange } from '../dates.js';
import { validateCombo } from '../schema.js';
import { join } from 'node:path';
import type { ToolDefinition } from '../report-tool-builder.js';
import type { GAMClient } from '../gam-client.js';

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
  op: z.enum(['=', 'IN', '!=']).default('='),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
});

const inputSchema = z.object({
  dimensions: z.array(z.string()).min(1).max(10),
  metrics: z.array(z.string()).min(1).max(20),
  date_range: dateRangeSchema,
  filters: z.array(filterSchema).optional(),
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

    try {
      const op = await ctx.client.createReport(
        { dimensions: input.dimensions, metrics: input.metrics, filters: input.filters },
        dateRange,
      );
      const status = await pollUntilDone(ctx.client, op.operation_name, ctx.reportTimeoutMs ?? 300_000);
      if ('error' in status) return status;
      const dest = join(ctx.output.tempDir, `${op.operation_name.replace(/[^\w]/g, '_')}.csv.gz`);
      await ctx.client.downloadReport(status.download_url, dest);
      return ctx.output.fromCsvGzFile(
        dest,
        `Report: dims=[${input.dimensions.join(',')}] metrics=[${input.metrics.join(',')}] ${dateRange.start}..${dateRange.end}`,
      );
    } catch (e) {
      return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
    }
  },
};

async function pollUntilDone(client: GAMClient, name: string, timeoutMs: number) {
  const start = Date.now();
  let delay = 2000;
  while (Date.now() - start < timeoutMs) {
    const s = await client.pollOperation(name);
    if (s.state === 'done') return { download_url: s.download_url };
    if (s.state === 'failed') return gamError('REPORT_FAILED', { reason: s.reason });
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15_000);
  }
  return gamError('REPORT_TIMEOUT', { timeout_ms: timeoutMs });
}
