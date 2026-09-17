import { z } from 'zod';
import { resolveDateRange } from '../dates.js';
import { executeReport } from '../report-exec.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

const inputSchema = z.object({
  line_item_ids: z.array(z.number().int().positive()).optional()
    .describe('Only these line items.'),
  order_ids: z.array(z.number().int().positive()).optional()
    .describe('Only line items of these orders.'),
}).strict();

export const pacingStatusTool: ToolDefinition<typeof inputSchema> = {
  name: 'pacing_status',
  description:
    'Current-period impressions and revenue per line item (month-to-date, network timezone). Useful for delivery monitoring. Note: pacing percentage vs. goal is not available via the REST Reports API. Optional filter by line_item_ids or order_ids.',
  input: inputSchema,
  async handler(input, ctx: ToolContext) {
    // ponytail: month_to_date fails on the 1st of a month; PR 4 moves this tool to an optional date_range (spec §4.3).
    const dateRange = resolveDateRange({ relative: 'month_to_date' }, { timezone: ctx.timezone, now: ctx.now, rule: 'historical' });
    if ('error' in dateRange) return dateRange;
    const query: ReportQuery = {
      dimensions: ['LINE_ITEM_NAME', 'LINE_ITEM_ID'],
      metrics: [
        'IMPRESSIONS',
        'REVENUE',
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

    return executeReport(ctx, {
      tool: 'pacing_status',
      query,
      dateRange,
      summary: `Pacing status (month to date, ${dateRange.start}..${dateRange.end})`,
    });
  },
};
