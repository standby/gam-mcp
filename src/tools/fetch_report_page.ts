import { z } from 'zod';
import { fetchReportPage } from '../report-exec.js';
import { READS_GAM, type ToolDefinition } from '../report-tool-builder.js';

const inputSchema = z.object({
  cursor: z.string().min(1).describe('The next_cursor value from an earlier report result, passed back unchanged.'),
}).strict();

export const fetchReportPageTool: ToolDefinition<typeof inputSchema> = {
  name: 'fetch_report_page',
  description:
    'Fetch the next page of rows from a report that another tool already ran. Pass the next_cursor from that result. ' +
    'Each page carries the same provenance as the first page and its own next_cursor until the last page. ' +
    'If GAM has discarded the result, re-run the original tool.',
  input: inputSchema,
  annotations: READS_GAM,
  handler: (input, ctx) => fetchReportPage(ctx, input.cursor),
};
