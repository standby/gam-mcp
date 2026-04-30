import { z } from 'zod';
import { gamError } from '../errors.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';

const ENTITY_TYPES = [
  'advertiser', 'order', 'line_item', 'ad_unit', 'creative', 'placement', 'company',
] as const;

const inputSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  query: z.string().min(1).optional(),
  ids: z.array(z.number().int().positive()).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).refine((v) => v.query !== undefined || (v.ids && v.ids.length > 0), {
  message: 'Provide either query or ids',
});

export const lookupTool: ToolDefinition<typeof inputSchema> = {
  name: 'lookup',
  description:
    'Resolve names ↔ IDs for GAM entities (advertiser, order, line_item, ad_unit, creative, placement, company). Supports substring search by query, or exact lookup by ids.',
  input: inputSchema,
  async handler(input, ctx: ToolContext) {
    const matches = await ctx.client.listEntities({
      entity_type: input.entity_type,
      query: input.query,
      ids: input.ids,
    });
    if (matches.length === 0) {
      return gamError('ENTITY_NOT_FOUND', {
        entity_type: input.entity_type,
        query: input.query ?? input.ids,
      });
    }
    const trimmed = matches.slice(0, input.limit);
    const rows = trimmed.map((e) => ({ id: String(e.id), name: e.name }));
    return ctx.output.fromInlineRows(
      rows,
      `${trimmed.length} ${input.entity_type}(s) matching ${JSON.stringify(input.query ?? input.ids)}`,
    );
  },
};
