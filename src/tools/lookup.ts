import { z } from 'zod';
import { gamError } from '../errors.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';
import { listEnvelope } from '../envelope.js';

const ENTITY_TYPES = [
  'advertiser', 'order', 'line_item', 'ad_unit', 'placement', 'company',
  'custom_targeting_key',
] as const;

const inputSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  query: z.string().min(1).optional(),
  ids: z.array(z.number().int().positive()).optional(),
  // Pagination is transparent — values up to 1000 page through GAM
  // automatically. Default 50 keeps responses small for exploratory queries.
  limit: z.number().int().min(1).max(1000).default(50),
  // 'substring' (default): AIP-160 has-operator on displayName.
  // 'exact': equality on the canonical name attribute. Required for resolving
  // a custom_targeting_key by its API code (the `channel_id` in
  // KEY_VALUES_NAME rows) — GAM accepts `name = "channel_id"` but rejects
  // substring CONTAINS-style filters on that attribute. For other entity
  // types it does exact equality on displayName.
  match: z.enum(['substring', 'exact']).default('substring'),
});

export const lookupTool: ToolDefinition<typeof inputSchema> = {
  name: 'lookup',
  description:
    'Resolve names ↔ IDs for GAM entities (advertiser, order, line_item, ad_unit, placement, company, custom_targeting_key). With query: substring match on name by default; pass match="exact" for equality (e.g. find a custom_targeting_key whose API code is exactly "channel_id"). With ids: exact lookup. With neither: list up to `limit` entries (default 50, max 1000 — pagination is automatic across GAM\'s 200-per-page responses). For custom_targeting_key, rows include both `name` (API code emitted in KEY_VALUES_NAME) and `displayName` (human-readable label). Use this to discover the key IDs needed for run_report\'s custom_dimension_key_ids parameter.',
  input: inputSchema,
  async handler(input, ctx: ToolContext) {
    let matches;
    try {
      matches = await ctx.client.listEntities({
        entity_type: input.entity_type,
        query: input.query,
        ids: input.ids,
        limit: input.limit,
        match: input.match,
      });
    } catch (e) {
      // Auto-fallback: GAM rejects substring filters on custom_targeting_key
      // when the attribute it tries to match isn't filter-eligible. Retry
      // with exact mode so callers can still resolve a key by its API code
      // even if they didn't explicitly opt in.
      const msg = e instanceof Error ? e.message : String(e);
      const isParseError = /400|INVALID_ARGUMENT|filter/i.test(msg);
      if (
        input.match === 'substring' &&
        input.query !== undefined &&
        input.entity_type === 'custom_targeting_key' &&
        isParseError
      ) {
        ctx.logger.warn('lookup.fallback_to_exact', {
          entity_type: input.entity_type,
          query: input.query,
          original_error: msg,
        });
        matches = await ctx.client.listEntities({
          entity_type: input.entity_type,
          query: input.query,
          ids: input.ids,
          limit: input.limit,
          match: 'exact',
        });
      } else {
        throw e;
      }
    }
    if (matches.length === 0) {
      return gamError('ENTITY_NOT_FOUND', {
        entity_type: input.entity_type,
        query: input.query ?? input.ids,
      });
    }
    const trimmed = matches.slice(0, input.limit);
    // Always include a displayName column so the LLM sees the shape even when
    // GAM didn't populate it for an individual row.
    const rows = trimmed.map((e) => ({
      id: String(e.id),
      name: e.name,
      displayName: e.displayName ?? e.name,
    }));
    const filterDesc = input.query !== undefined
      ? ` matching ${JSON.stringify(input.query)} (${input.match})`
      : input.ids?.length
        ? ` matching ids ${JSON.stringify(input.ids)}`
        : '';
    return listEnvelope(
      rows,
      `${trimmed.length} ${input.entity_type}(s)${filterDesc}`,
      [
        { name: 'id', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'displayName', type: 'string' },
      ],
    );
  },
};
