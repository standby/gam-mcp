import { z } from 'zod';
import { gamError } from '../errors.js';
import { validateCombo } from '../schema.js';
import { runReportTool } from './run_report.js';
import type { ToolDefinition, ToolContext } from '../report-tool-builder.js';

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
  op: z.enum(['=', 'IN', '!=', 'CONTAINS', 'NOT_CONTAINS']).default('='),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
});

const savedBodySchema = z.object({
  dimensions: z.array(z.string()).min(1).max(10),
  metrics: z.array(z.string()).min(1).max(20),
  filters: z.array(filterSchema).optional(),
  custom_dimension_key_ids: z.array(z.number().int().positive()).optional(),
});

// ------------------------------- save_query -------------------------------

const saveInput = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, 'name must be alphanumeric / _ / -'),
  description: z.string().max(500).optional(),
  dimensions: z.array(z.string()).min(1).max(10),
  metrics: z.array(z.string()).min(1).max(20),
  filters: z.array(filterSchema).optional(),
  custom_dimension_key_ids: z.array(z.number().int().positive()).optional(),
  replace: z.boolean().default(false),
});

export const saveQueryTool: ToolDefinition<typeof saveInput> = {
  name: 'save_query',
  description:
    'Persist a run_report-shaped query template under a name for later replay. ' +
    'Stores dimensions, metrics, filters, and custom_dimension_key_ids. ' +
    'Date range is deliberately NOT saved — replay always provides a fresh date_range, since "this report shape but for this week" is the universal use case. ' +
    'Set replace=true to overwrite an existing name (default refuses). ' +
    'Storage location is the file pointed to by GAM_SAVED_QUERIES_FILE (default: ${XDG_CONFIG_HOME:-$HOME/.config}/gam-mcp/saved-queries.json).',
  input: saveInput,
  async handler(input, ctx: ToolContext) {
    if (!ctx.savedQueries) {
      return gamError('INTERNAL_ERROR', { reason: 'saved-query store is not configured' });
    }
    const comboError = validateCombo({ dimensions: input.dimensions, metrics: input.metrics });
    if (comboError) {
      return gamError('INVALID_INPUT', { reason: comboError, hint: 'Call describe_schema for valid names.' });
    }
    const existing = ctx.savedQueries.get(input.name);
    if (existing && !input.replace) {
      return gamError('INVALID_INPUT', {
        reason: `A saved query named "${input.name}" already exists (saved ${existing.saved_at}).`,
        hint: 'Pass replace=true to overwrite, or pick a different name.',
      });
    }
    const entry = ctx.savedQueries.save(
      input.name,
      {
        dimensions: input.dimensions,
        metrics: input.metrics,
        ...(input.filters && { filters: input.filters }),
        ...(input.custom_dimension_key_ids && { custom_dimension_key_ids: input.custom_dimension_key_ids }),
      },
      input.description,
    );
    return ctx.output.fromInlineRows(
      [{ name: entry.name, saved_at: entry.saved_at, description: entry.description ?? '' }],
      `Saved query "${entry.name}" (${existing ? 'replaced' : 'new'}).`,
    );
  },
};

// ---------------------------- list_saved_queries --------------------------

const listInput = z.object({});

export const listSavedQueriesTool: ToolDefinition<typeof listInput> = {
  name: 'list_saved_queries',
  description: 'List all saved query templates with their names, descriptions, and save timestamps.',
  input: listInput,
  async handler(_input, ctx: ToolContext) {
    if (!ctx.savedQueries) {
      return gamError('INTERNAL_ERROR', { reason: 'saved-query store is not configured' });
    }
    const entries = ctx.savedQueries.list();
    const rows = entries.map((e) => ({
      name: e.name,
      description: e.description ?? '',
      dimensions: e.body.dimensions.join(','),
      metrics: e.body.metrics.join(','),
      saved_at: e.saved_at,
    }));
    return ctx.output.fromInlineRows(rows, `${entries.length} saved query template(s).`);
  },
};

// ---------------------------- run_saved_query -----------------------------

const runInput = z.object({
  name: z.string().min(1),
  date_range: dateRangeSchema,
});

export const runSavedQueryTool: ToolDefinition<typeof runInput> = {
  name: 'run_saved_query',
  description:
    'Replay a previously saved query against a fresh date_range. The saved template provides dimensions/metrics/filters/custom_dimension_key_ids; you supply the time window. Equivalent to calling run_report with the saved fields merged in.',
  input: runInput,
  async handler(input, ctx: ToolContext) {
    if (!ctx.savedQueries) {
      return gamError('INTERNAL_ERROR', { reason: 'saved-query store is not configured' });
    }
    const entry = ctx.savedQueries.get(input.name);
    if (!entry) {
      return gamError('ENTITY_NOT_FOUND', {
        entity_type: 'saved_query',
        query: input.name,
      });
    }
    // Validate the body shape — guards against hand-edited or older-format files.
    const bodyParse = savedBodySchema.safeParse(entry.body);
    if (!bodyParse.success) {
      return gamError('INVALID_INPUT', { reason: `saved query "${input.name}" body is malformed: ${bodyParse.error.message}` });
    }
    return runReportTool.handler(
      {
        dimensions: bodyParse.data.dimensions,
        metrics: bodyParse.data.metrics,
        filters: bodyParse.data.filters,
        custom_dimension_key_ids: bodyParse.data.custom_dimension_key_ids,
        date_range: input.date_range,
      },
      ctx,
    );
  },
};

// ---------------------------- delete_saved_query --------------------------

const deleteInput = z.object({ name: z.string().min(1) });

export const deleteSavedQueryTool: ToolDefinition<typeof deleteInput> = {
  name: 'delete_saved_query',
  description: 'Delete a saved query template by name. Returns success even if the name did not exist.',
  input: deleteInput,
  async handler(input, ctx: ToolContext) {
    if (!ctx.savedQueries) {
      return gamError('INTERNAL_ERROR', { reason: 'saved-query store is not configured' });
    }
    const removed = ctx.savedQueries.delete(input.name);
    return ctx.output.fromInlineRows(
      [{ name: input.name, removed: String(removed) }],
      removed ? `Deleted saved query "${input.name}".` : `No saved query named "${input.name}".`,
    );
  },
};
