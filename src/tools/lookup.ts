import { z } from 'zod';
import { gamError } from '../errors.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';

const ENTITY_TYPES = [
  'advertiser', 'order', 'line_item', 'ad_unit', 'creative', 'placement', 'company',
  'custom_targeting_key',
] as const;

const inputSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  query: z.string().min(1).optional(),
  ids: z.array(z.number().int().positive()).optional(),
  // Pagination is transparent — values up to 1000 page through GAM
  // automatically. Default 50 keeps responses small for exploratory queries.
  limit: z.number().int().min(1).max(1000).default(50),
});

export const lookupTool: ToolDefinition<typeof inputSchema> = {
  name: 'lookup',
  description:
    'Resolve names ↔ IDs for GAM entities (advertiser, order, line_item, ad_unit, creative, placement, company, custom_targeting_key). With query: substring match on name (literal — no wildcards). With ids: exact lookup. With neither: list up to `limit` entries (default 50, max 1000 — pagination is automatic across GAM\'s 200-per-page responses). Use entity_type="custom_targeting_key" to discover the key IDs needed for run_report\'s custom_dimension_key_ids parameter.',
  input: inputSchema,
  async handler(input, ctx: ToolContext) {
    const matches = await ctx.client.listEntities({
      entity_type: input.entity_type,
      query: input.query,
      ids: input.ids,
      limit: input.limit,
    });
    if (matches.length === 0) {
      return gamError('ENTITY_NOT_FOUND', {
        entity_type: input.entity_type,
        query: input.query ?? input.ids,
      });
    }
    const trimmed = matches.slice(0, input.limit);
    const rows = trimmed.map((e) => ({ id: String(e.id), name: e.name }));
    const filterDesc = input.query !== undefined
      ? ` matching ${JSON.stringify(input.query)}`
      : input.ids?.length
        ? ` matching ids ${JSON.stringify(input.ids)}`
        : '';
    return ctx.output.fromInlineRows(
      rows,
      `${trimmed.length} ${input.entity_type}(s)${filterDesc}`,
    );
  },
};
