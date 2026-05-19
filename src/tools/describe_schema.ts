import { z } from 'zod';
import { GAM_SCHEMA } from '../schema.js';
import type { ToolDefinition } from '../report-tool-builder.js';

const inputSchema = z.object({
  kind: z.enum(['dimension', 'metric', 'all']).default('all'),
});

export const describeSchemaTool: ToolDefinition<typeof inputSchema> = {
  name: 'describe_schema',
  description:
    'List the GAM dimensions and metrics this MCP can query in run_report. Returns names, types, descriptions, and a curated incompatibility hint (`incompatible_with`) listing dimensions/metrics that GAM refuses to combine — e.g., KEY_VALUES_NAME ⊥ AD_REQUESTS. The matrix is best-effort; an empty `incompatible_with` does not guarantee GAM will accept the combination.',
  input: inputSchema,
  async handler(input, ctx) {
    const rows: Record<string, string>[] = [];
    if (input.kind === 'dimension' || input.kind === 'all') {
      for (const d of GAM_SCHEMA.dimensions) {
        rows.push({
          kind: 'dimension',
          name: d.name,
          type: d.type,
          description: d.description,
          incompatible_with: (d.incompatible_with ?? []).join(', '),
        });
      }
    }
    if (input.kind === 'metric' || input.kind === 'all') {
      for (const m of GAM_SCHEMA.metrics) {
        rows.push({
          kind: 'metric',
          name: m.name,
          type: m.type,
          description: m.description,
          incompatible_with: (m.incompatible_with ?? []).join(', '),
        });
      }
    }
    return ctx.output.fromInlineRows(
      rows,
      `GAM schema (${rows.length} entries)`,
      [
        { name: 'kind', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'type', type: 'string' },
        { name: 'description', type: 'string' },
        { name: 'incompatible_with', type: 'string' },
      ],
    );
  },
};
