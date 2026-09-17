import { z } from 'zod';
import { gamError } from '../errors.js';
import { validateCombo } from '../schema.js';
import { runReportTool } from './run_report.js';
import { READS_GAM, READS_LOCAL, WRITES_LOCAL, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';
import { listEnvelope } from '../envelope.js';
import { dateRangeInput, filterInput } from '../tool-input.js';

const savedBodySchema = z.object({
  dimensions: z.array(z.string()).min(1).max(10),
  metrics: z.array(z.string()).min(1).max(20),
  filters: z.array(filterInput).optional(),
  custom_dimension_key_ids: z.array(z.number().int().positive()).optional(),
});

// ------------------------------- save_query -------------------------------

const saveInput = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, 'name must be alphanumeric / _ / -')
    .describe('Name to save the template under: letters, digits, _ and -, at most 64 characters.'),
  description: z.string().max(500).optional()
    .describe('What the template is for, at most 500 characters.'),
  dimensions: z.array(z.string()).min(1).max(10)
    .describe('1-10 dimension names, as run_report takes them.'),
  metrics: z.array(z.string()).min(1).max(20)
    .describe('1-20 metric names, as run_report takes them.'),
  filters: z.array(filterInput).optional()
    .describe('Filters, as run_report takes them.'),
  custom_dimension_key_ids: z.array(z.number().int().positive()).optional()
    .describe('Custom targeting key IDs for CUSTOM_DIMENSION_<N>_VALUE dimensions, as run_report takes them.'),
  replace: z.boolean().default(false)
    .describe('Overwrite a template that already has this name. Without it, saving under a taken name fails.'),
}).strict();

export const saveQueryTool: ToolDefinition<typeof saveInput> = {
  name: 'save_query',
  description:
    'Persist a run_report-shaped query template under a name for later replay. ' +
    'Stores dimensions, metrics, filters, and custom_dimension_key_ids. ' +
    'Date range is deliberately NOT saved — replay always provides a fresh date_range, since "this report shape but for this week" is the universal use case. ' +
    'Set replace=true to overwrite an existing name (default refuses). ' +
    'Storage location is the file pointed to by GAM_SAVED_QUERIES_FILE (default: ${XDG_CONFIG_HOME:-$HOME/.config}/gam-mcp/saved-queries.json).',
  input: saveInput,
  annotations: WRITES_LOCAL,
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
    return listEnvelope(
      [{ name: entry.name, saved_at: entry.saved_at, description: entry.description ?? '' }],
      `Saved query "${entry.name}" (${existing ? 'replaced' : 'new'}).`,
    );
  },
};

// ---------------------------- list_saved_queries --------------------------

const listInput = z.object({}).strict();

export const listSavedQueriesTool: ToolDefinition<typeof listInput> = {
  name: 'list_saved_queries',
  description: 'List all saved query templates with their names, descriptions, and save timestamps.',
  input: listInput,
  annotations: READS_LOCAL,
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
    return listEnvelope(rows, `${entries.length} saved query template(s).`);
  },
};

// ---------------------------- run_saved_query -----------------------------

const runInput = z.object({
  name: z.string().min(1).describe('The saved template to run.'),
  date_range: dateRangeInput('The dates to run the template over, with the same rules as run_report.'),
}).strict();

export const runSavedQueryTool: ToolDefinition<typeof runInput> = {
  name: 'run_saved_query',
  description:
    'Replay a previously saved query against a fresh date_range. The saved template provides dimensions/metrics/filters/custom_dimension_key_ids; you supply the time window. Equivalent to calling run_report with the saved fields merged in.',
  input: runInput,
  annotations: READS_GAM,
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

const deleteInput = z.object({
  name: z.string().min(1).describe('The saved template to delete.'),
}).strict();

export const deleteSavedQueryTool: ToolDefinition<typeof deleteInput> = {
  name: 'delete_saved_query',
  description: 'Delete a saved query template by name. Returns success even if the name did not exist.',
  input: deleteInput,
  annotations: WRITES_LOCAL,
  async handler(input, ctx: ToolContext) {
    if (!ctx.savedQueries) {
      return gamError('INTERNAL_ERROR', { reason: 'saved-query store is not configured' });
    }
    const removed = ctx.savedQueries.delete(input.name);
    return listEnvelope(
      [{ name: input.name, removed: String(removed) }],
      removed ? `Deleted saved query "${input.name}".` : `No saved query named "${input.name}".`,
    );
  },
};

// The saved-query tools, as one list: `toolsFor` keeps them off HTTP and the
// tests read the same list, so the set cannot be described twice and drift.
export const SAVED_QUERY_TOOLS: ToolDefinition[] = [
  saveQueryTool,
  listSavedQueriesTool,
  runSavedQueryTool,
  deleteSavedQueryTool,
];
