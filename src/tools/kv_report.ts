import { z } from 'zod';
import { gamError } from '../errors.js';
import { resolveDateRange } from '../dates.js';
import { validateCombo } from '../schema.js';
import { executeReport } from '../report-exec.js';
import { makeKvResolver, parseKvPair } from '../kv-rewrite.js';
import type { ToolDefinition } from '../report-tool-builder.js';
import type { ReportQuery, DateRange } from '../gam-client.js';

const RELATIVE = z.enum([
  'today', 'yesterday', 'last_7_days', 'last_30_days', 'last_week',
  'last_full_month', 'month_to_date', 'quarter_to_date', 'last_quarter', 'year_to_date',
]);

const dateRangeSchema = z.union([
  z.object({ start: z.string(), end: z.string() }),
  z.object({ relative: RELATIVE }),
]);

const inputSchema = z.object({
  // KV pair to slice on, in `key=value` form (e.g. `channel_id=479`). The
  // key is resolved to a custom_targeting_key ID via lookup, then plugged
  // into CUSTOM_DIMENSION_<N>_VALUE so the report is compatible with any
  // request-time or programmatic metric.
  kv: z.string().regex(/^[^=]+=[^=]+$/, 'must be in key=value form'),
  date_range: dateRangeSchema,
  metrics: z.array(z.string()).min(1).max(20),
  // Optional narrowing. ad_unit_id is preferred; ad_unit_name does an exact
  // displayName lookup first. order_id and line_item_id apply AND filters
  // alongside the KV filter.
  ad_unit_id: z.number().int().positive().optional(),
  ad_unit_name: z.string().optional(),
  order_id: z.number().int().positive().optional(),
  line_item_id: z.number().int().positive().optional(),
  // Extra dimensions to group by, on top of the KV slot. Default: just the
  // slot itself (one row per KV value). Pass e.g. ['DATE'] for a daily trend.
  dimensions: z.array(z.string()).max(9).default([]),
});

export const kvReportTool: ToolDefinition<typeof inputSchema> = {
  name: 'kv_report',
  description:
    "High-level KV-narrowed report. Accepts kv='key=value' (e.g. 'channel_id=479'), date_range, and metrics; internally resolves the key via lookup, picks a CUSTOM_DIMENSION slot, and runs a report that's compatible with request-time metrics (AD_REQUESTS, AdX/AdSense, etc.) that GAM normally forbids alongside KEY_VALUES_NAME. Optionally narrows by ad_unit_id, ad_unit_name (exact displayName match), order_id, or line_item_id.",
  input: inputSchema,
  async handler(input, ctx) {
    const parsed = parseKvPair(input.kv);
    if (!parsed) {
      return gamError('INVALID_INPUT', {
        reason: `kv must be in 'key=value' form; got ${JSON.stringify(input.kv)}`,
        hint: "Example: kv='channel_id=479'",
      });
    }

    const comboError = validateCombo({
      dimensions: input.dimensions,
      metrics: input.metrics,
    });
    if (comboError) {
      return gamError('INVALID_INPUT', { reason: comboError, hint: 'Call describe_schema for valid names.' });
    }

    let dateRange: DateRange;
    try {
      dateRange = resolveDateRange(input.date_range, ctx.timezone, ctx.now);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return gamError('INVALID_DATE_RANGE', { reason: msg });
    }

    // Resolve the KV key → ID
    const resolve = makeKvResolver(ctx.client);
    const keyId = await resolve(parsed.key);
    if (!keyId) {
      return gamError('ENTITY_NOT_FOUND', {
        entity_type: 'custom_targeting_key',
        query: parsed.key,
      });
    }

    // Resolve ad_unit_name if given
    let adUnitId = input.ad_unit_id;
    if (adUnitId === undefined && input.ad_unit_name) {
      const matches = await ctx.client.listEntities({
        entity_type: 'ad_unit',
        query: input.ad_unit_name,
        match: 'exact',
        limit: 5,
      });
      const hit = matches.find((m) => m.name === input.ad_unit_name)
        ?? matches.find((m) => m.displayName === input.ad_unit_name)
        ?? matches[0];
      if (!hit) {
        return gamError('ENTITY_NOT_FOUND', {
          entity_type: 'ad_unit',
          query: input.ad_unit_name,
        });
      }
      adUnitId = hit.id;
    }

    // Slot 0 is fine; we own the whole report. The CUSTOM_DIMENSION_0_VALUE
    // is the filter target; the caller's `dimensions` are appended for
    // grouping.
    const filters: NonNullable<ReportQuery['filters']> = [
      { field: 'CUSTOM_DIMENSION_0_VALUE', op: '=', value: parsed.value },
    ];
    if (adUnitId !== undefined) filters.push({ field: 'AD_UNIT_ID', op: '=', value: adUnitId });
    if (input.order_id !== undefined) filters.push({ field: 'ORDER_ID', op: '=', value: input.order_id });
    if (input.line_item_id !== undefined) filters.push({ field: 'LINE_ITEM_ID', op: '=', value: input.line_item_id });

    const dimensions = ['CUSTOM_DIMENSION_0_VALUE', ...input.dimensions];

    const query: ReportQuery = {
      dimensions,
      metrics: input.metrics,
      filters,
      custom_dimension_key_ids: [keyId],
    };

    const scopeParts: string[] = [`kv=${parsed.key}=${parsed.value}`];
    if (adUnitId !== undefined) scopeParts.push(`ad_unit=${adUnitId}`);
    if (input.order_id !== undefined) scopeParts.push(`order=${input.order_id}`);
    if (input.line_item_id !== undefined) scopeParts.push(`line_item=${input.line_item_id}`);
    const summary =
      `kv_report (${scopeParts.join(', ')}) metrics=[${input.metrics.join(',')}] ` +
      `${dateRange.start}..${dateRange.end}`;
    const warnings = [
      `Resolved '${parsed.key}' to custom_targeting_key_id=${keyId}; filtering on CUSTOM_DIMENSION_0_VALUE='${parsed.value}'.`,
    ];

    return executeReport(ctx, { tool: 'kv_report', query, dateRange, summary, warnings });
  },
};
