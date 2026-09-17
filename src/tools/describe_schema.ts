import { z } from 'zod';
import { GAM_SCHEMA, REPORT_TYPES, SUPPORTED_REPORT_TYPES } from '../schema.js';
import type { ToolDefinition } from '../report-tool-builder.js';

// GAM declares ~1290 dimensions and metrics. Returning all of them with prose
// would swamp the caller's context, so an unfiltered call returns names and
// types only and the descriptions are opt-in via a filter. Filters compose
// (AND) — report_type narrows to a report family, family to a name prefix,
// search to a substring of the name or description.
const DESCRIPTION_BUDGET = 200;

const inputSchema = z.object({
  kind: z.enum(['dimension', 'metric', 'all']).default('all')
    .describe('Restrict to dimensions, metrics, or both.'),
  report_type: z.string().optional()
    .describe(
      `Only entries queryable under this GAM report type. One of: ${REPORT_TYPES.join(', ')}. ` +
      `Reports are run as exactly one type, so this is the best first filter — it shows what ` +
      `can legally appear in the same request.`,
    ),
  family: z.string().optional()
    .describe("Name prefix, e.g. 'AD_EXCHANGE', 'VIDEO_VIEWERSHIP', 'YIELD_GROUP'. Case-insensitive."),
  search: z.string().optional()
    .describe('Substring match on name or description, e.g. "viewab", "unique visitor", "passback".'),
  include_descriptions: z.boolean().optional()
    .describe('Force descriptions on or off. Defaults to on when any filter is set, off otherwise.'),
  limit: z.number().int().min(1).max(1000).default(300)
    .describe('Maximum entries to return.'),
});

export const describeSchemaTool: ToolDefinition<typeof inputSchema> = {
  name: 'describe_schema',
  description:
    'List the GAM dimensions and metrics this MCP can query in run_report. GAM declares ~1290 of them, ' +
    'so filter: report_type (what can appear in one request together), family (name prefix), or search ' +
    '(substring). An unfiltered call returns names and types only; any filter turns on descriptions. ' +
    'Also returns a curated incompatibility hint (`incompatible_with`) listing names GAM refuses to ' +
    'combine — e.g. KEY_VALUES_NAME ⊥ AD_REQUESTS. That matrix is best-effort: an empty ' +
    '`incompatible_with` does not guarantee GAM will accept the combination.',
  input: inputSchema,
  async handler(input, ctx) {
    const filtered = input.report_type || input.family || input.search;
    const withDescriptions = input.include_descriptions ?? Boolean(filtered);

    const reportType = input.report_type?.toUpperCase();
    if (reportType && !(REPORT_TYPES as readonly string[]).includes(reportType)) {
      return ctx.output!.fromInlineRows(
        [],
        `Unknown report_type '${input.report_type}'. Valid: ${REPORT_TYPES.join(', ')}`,
      );
    }
    const family = input.family?.toUpperCase();
    const search = input.search?.toLowerCase();

    const matches = (e: { name: string; description: string; report_types: string[] }): boolean => {
      if (reportType && !e.report_types.includes(reportType)) return false;
      if (family && !e.name.toUpperCase().startsWith(family)) return false;
      if (search &&
          !e.name.toLowerCase().includes(search) &&
          !e.description.toLowerCase().includes(search)) return false;
      return true;
    };

    const rows: Record<string, string>[] = [];
    const push = (kind: 'dimension' | 'metric', e: {
      name: string; type: string; description: string;
      report_types: string[]; incompatible_with?: string[];
    }) => {
      const row: Record<string, string> = { kind, name: e.name, type: e.type };
      if (withDescriptions) {
        row.description = e.description;
        row.report_types = e.report_types.join(', ');
        row.incompatible_with = (e.incompatible_with ?? []).join(', ');
      }
      rows.push(row);
    };

    const wantDims = input.kind === 'dimension' || input.kind === 'all';
    const wantMetrics = input.kind === 'metric' || input.kind === 'all';
    const dims = wantDims ? GAM_SCHEMA.dimensions.filter(matches) : [];
    const mets = wantMetrics ? GAM_SCHEMA.metrics.filter(matches) : [];
    const total = dims.length + mets.length;

    // Split the budget per kind rather than filling dimensions first: there are
    // 764 dimensions to 526 metrics, so a single shared limit would return an
    // all-dimension page and hide metrics entirely on an unfiltered call.
    const perKind = input.kind === 'all' ? Math.ceil(input.limit / 2) : input.limit;
    for (const d of dims.slice(0, perKind)) push('dimension', d);
    for (const m of mets.slice(0, perKind)) push('metric', m);

    const bits = [`${rows.length} of ${total} matching entries`];
    if (reportType) {
      bits.push(
        `report_type=${reportType}` +
        (SUPPORTED_REPORT_TYPES.includes(reportType as never) ? '' : ' (forwarded but unverified)'),
      );
    }
    if (family) bits.push(`family=${family}`);
    if (search) bits.push(`search="${input.search}"`);
    // Silent truncation reads as "that's everything" — say so when it isn't.
    if (total > rows.length) bits.push(`truncated at limit=${input.limit}, narrow the filter`);
    if (!withDescriptions) bits.push('names only — pass a filter or include_descriptions for prose');
    else if (total > DESCRIPTION_BUDGET) {
      bits.push(`${total} entries with prose is a lot of context; consider a narrower filter`);
    }

    const schema = [
      { name: 'kind', type: 'string' as const },
      { name: 'name', type: 'string' as const },
      { name: 'type', type: 'string' as const },
      ...(withDescriptions ? [
        { name: 'description', type: 'string' as const },
        { name: 'report_types', type: 'string' as const },
        { name: 'incompatible_with', type: 'string' as const },
      ] : []),
    ];

    return ctx.output!.fromInlineRows(rows, `GAM schema — ${bits.join('; ')}`, schema);
  },
};
