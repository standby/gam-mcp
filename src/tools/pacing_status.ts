import { z } from 'zod';
import { join } from 'node:path';
import { gamError } from '../errors.js';
import { resolveDateRange } from '../dates.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

const inputSchema = z.object({
  line_item_ids: z.array(z.number().int().positive()).optional(),
  order_ids: z.array(z.number().int().positive()).optional(),
});

export const pacingStatusTool: ToolDefinition<typeof inputSchema> = {
  name: 'pacing_status',
  description:
    'Pacing status (delivered vs. expected) for currently-flighting line items, month-to-date in the network timezone. Returns line_item_progress (0..1+) along with delivered impressions and goal quantity. Optional filter by line_item_ids or order_ids.',
  input: inputSchema,
  async handler(input, ctx: ToolContext) {
    const dateRange = resolveDateRange({ relative: 'month_to_date' }, ctx.timezone, ctx.now);
    const query: ReportQuery = {
      dimensions: ['LINE_ITEM_NAME', 'LINE_ITEM_ID'],
      metrics: [
        'LINE_ITEM_PROGRESS',
        'LINE_ITEM_LIFETIME_IMPRESSIONS_DELIVERED',
        'LINE_ITEM_GOAL_QUANTITY',
      ],
      filters: [
        ...(input.line_item_ids?.length
          ? [{ field: 'LINE_ITEM_ID', op: 'IN' as const, value: input.line_item_ids }]
          : []),
        ...(input.order_ids?.length
          ? [{ field: 'ORDER_ID', op: 'IN' as const, value: input.order_ids }]
          : []),
      ],
    };

    const op = await ctx.client.createReport(query, dateRange);
    const timeout = ctx.reportTimeoutMs ?? 300_000;
    const start = Date.now();
    let delay = 2000;
    while (Date.now() - start < timeout) {
      const s = await ctx.client.pollOperation(op.operation_name);
      if (s.state === 'done') {
        const dest = join(ctx.output.tempDir, `${op.operation_name.replace(/[^\w]/g, '_')}.csv.gz`);
        await ctx.client.downloadReport(s.download_url, dest);
        return ctx.output.fromCsvGzFile(dest, 'Pacing status (current month)');
      }
      if (s.state === 'failed') return gamError('REPORT_FAILED', { reason: s.reason });
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 15_000);
    }
    return gamError('REPORT_TIMEOUT', { timeout_ms: timeout });
  },
};
