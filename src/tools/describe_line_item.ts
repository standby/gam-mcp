import { z } from 'zod';
import { gamError } from '../errors.js';
import { READS_GAM, type ToolDefinition, type ToolContext } from '../report-tool-builder.js';

// Resource paths GAM embeds inside a line item's targeting. Only these
// collections carry a label worth resolving; every other string passes
// through untouched.
const RESOLVABLE_PATH =
  /^networks\/\d+\/(?:customTargetingKeys|customTargetingValues|adUnits|placements)\/\d+$/;

type Resolved = { id: string; name: string; displayName?: string };

// Resolve this many paths at a time. A handful of line items can reference
// hundreds of value ids; firing them all at once throttles the whole batch,
// and every throttled path then degrades to a raw label — which reads exactly
// like a deleted resource. Measured: 229 paths in one shot lost 124 of them.
const RESOLVE_BATCH = 20;

const inputSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(50)
    .describe('Line item IDs to describe, 1-50 per call. Resolve names to IDs with lookup(entity_type="line_item").'),
}).strict();

export const describeLineItemTool: ToolDefinition<typeof inputSchema> = {
  name: 'describe_line_item',
  description:
    'Read a line item\'s configuration — what it was set up to do, as opposed to what it delivered. ' +
    'Returns the raw GAM line item per id: status, reservationStatus, startTime/endTime, lineItemType, priority, ' +
    'rate/costType/goal, frequencyCaps, creativeRotationType, deliveryRateType, roadblockingType, environmentType, ' +
    'creativePlaceholders, targeting, and the rest of the resource unmodified. ' +
    'Two derivations are added. `custom_targeting` flattens targeting.customTargeting into readable clauses: ' +
    'clauses are OR\'d with each other, literals within one clause are AND\'d, and `op` is "IS ANY OF" for a ' +
    'positive literal or "IS NONE OF" for a negated one. `resolved_paths` maps every GAM resource path found in ' +
    'the targeting — publisher-configured custom targeting keys and values, ad units, placements — to its API code ' +
    'and display name; a path that cannot be resolved is simply absent and the raw path stands. ' +
    'No reporting dimension exposes a targeting expression, so this is the only way to see what a line item ' +
    'targets: read it here rather than inferring it from delivery data. Read-only.',
  input: inputSchema,
  annotations: READS_GAM,
  async handler(input, ctx: ToolContext) {
    const fetched = await Promise.all(
      input.ids.map(async (id) => ({ id, raw: await ctx.client.getResource(`lineItems/${id}`) })),
    );
    const found = fetched.filter((f): f is { id: number; raw: Record<string, unknown> } => f.raw !== null);
    const notFound = fetched.filter((f) => f.raw === null).map((f) => f.id);
    if (found.length === 0) {
      return gamError('ENTITY_NOT_FOUND', { entity_type: 'line_item', query: input.ids });
    }

    // Resolve each referenced path exactly once, in bounded batches.
    const paths = new Set<string>();
    for (const f of found) collectPaths(f.raw.targeting, paths);
    const unique = [...paths];
    const resolved = new Map<string, Resolved>();
    let failed = 0;
    for (let i = 0; i < unique.length; i += RESOLVE_BATCH) {
      await Promise.all(unique.slice(i, i + RESOLVE_BATCH).map(async (path) => {
        try {
          const r = await ctx.client.getResource(path);
          // null means GAM 404'd it: the resource is gone, which is a fact
          // about the network, not a failure of this call.
          if (r) resolved.set(path, toResolved(path, r));
        } catch (e) {
          // An error must still degrade to the raw path rather than sink the
          // whole call — but the caller has to be able to tell a throttled
          // lookup from an absent resource, so count it and say so.
          failed++;
          ctx.logger.warn('describe_line_item.resolve_failed', {
            path,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }));
    }

    const line_items = found.map((f) => ({
      ...f.raw,
      id: f.id,
      custom_targeting: flattenCustomTargeting(f.raw.targeting, resolved),
    }));

    return {
      summary:
        `${line_items.length} line item(s) described` +
        (notFound.length ? `, ${notFound.length} not found` : '') +
        `; ${resolved.size} of ${unique.length} targeting resource path(s) resolved` +
        (failed ? `, ${failed} failed to fetch` : '') + '.',
      line_items,
      resolved_paths: Object.fromEntries(resolved),
      resolution: {
        referenced: unique.length,
        resolved: resolved.size,
        missing: unique.length - resolved.size - failed,
        failed,
      },
      ...(notFound.length ? { not_found: notFound } : {}),
      ...(failed ? {
        warnings: [
          `${failed} targeting resource path(s) could not be fetched (rate limit or permission), ` +
          'so their labels fall back to the raw resource path. Those labels are unknown, not absent — re-run for complete output.',
        ],
      } : {}),
    };
  },
};

// Walk any nested value collecting GAM resource paths we know how to label.
// Generic on purpose: targeting nests differently per targeting family
// (inventory, custom, technology, geo) and new families should not need code.
function collectPaths(node: unknown, into: Set<string>): void {
  if (typeof node === 'string') {
    if (RESOLVABLE_PATH.test(node)) into.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectPaths(v, into);
    return;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectPaths(v, into);
  }
}

function toResolved(path: string, r: Record<string, unknown>): Resolved {
  const id = path.split('/').pop() ?? path;
  const adTagName = typeof r.adTagName === 'string' ? r.adTagName : undefined;
  const displayName = typeof r.displayName === 'string' ? r.displayName : undefined;
  // Prefer adTagName: it is the code that appears in KEY_VALUES_NAME report
  // rows, so it joins to reporting output.
  const name = adTagName ?? displayName ?? id;
  return { id, name, ...(displayName && displayName !== name ? { displayName } : {}) };
}

type TargetingClause = {
  clause: number;
  key: string;
  key_id: string;
  op: 'IS ANY OF' | 'IS NONE OF';
  values: string[];
  value_ids: string[];
  // Anything GAM sent on the literal that we do not map. Surfaced rather than
  // dropped: if negation ever arrives under a different field name, `op`
  // would read IS ANY OF for an exclusion — a wrong answer that looks right.
  // This makes that visible instead.
  unrecognized_fields?: Record<string, unknown>;
};

const KNOWN_LITERAL_FIELDS = new Set(['customTargetingKey', 'customTargetingValues', 'negative']);

// GAM nests customTargetingClauses[].customTargetingLiterals[] with a
// `negative` boolean. Flatten to one row per literal, keeping the clause index
// so the OR-of-ANDs structure survives.
function flattenCustomTargeting(targeting: unknown, resolved: Map<string, Resolved>): TargetingClause[] {
  const clauses = (targeting as any)?.customTargeting?.customTargetingClauses;
  if (!Array.isArray(clauses)) return [];
  const out: TargetingClause[] = [];
  clauses.forEach((clause: any, i: number) => {
    const literals = Array.isArray(clause?.customTargetingLiterals) ? clause.customTargetingLiterals : [];
    for (const lit of literals) {
      const keyPath = typeof lit?.customTargetingKey === 'string' ? lit.customTargetingKey : '';
      const valuePaths: string[] = Array.isArray(lit?.customTargetingValues)
        ? lit.customTargetingValues.filter((v: unknown): v is string => typeof v === 'string')
        : [];
      const extra = Object.fromEntries(
        Object.entries(lit ?? {}).filter(([k]) => !KNOWN_LITERAL_FIELDS.has(k)),
      );
      out.push({
        clause: i,
        key: label(keyPath, resolved),
        key_id: tailId(keyPath),
        op: lit?.negative === true ? 'IS NONE OF' : 'IS ANY OF',
        values: valuePaths.map((v) => label(v, resolved)),
        value_ids: valuePaths.map(tailId),
        ...(Object.keys(extra).length ? { unrecognized_fields: extra } : {}),
      });
    }
  });
  return out;
}

function label(path: string, resolved: Map<string, Resolved>): string {
  return resolved.get(path)?.name ?? path;
}

function tailId(path: string): string {
  return path.split('/').pop() ?? path;
}
