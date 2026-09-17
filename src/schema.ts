import {
  GENERATED_DIMENSIONS,
  GENERATED_METRICS,
  REPORT_TYPES,
  type GeneratedEntry,
} from './schema-generated.js';
import { CURATED_DIMENSIONS, CURATED_METRICS, type Override } from './schema-overrides.js';

export type ReportType = (typeof REPORT_TYPES)[number];

export type DimensionDef = {
  name: string;
  type: 'string' | 'number' | 'date';
  description: string;
  /** GAM report types this dimension can be queried under. */
  report_types: string[];
  incompatible_with?: string[];
};
export type MetricDef = {
  name: string;
  type: 'number' | 'currency' | 'rate';
  description: string;
  report_types: string[];
  incompatible_with?: string[];
};

// The generated enum is the source of truth for *which* names exist and what
// report types accept them; the curated file supplies better prose and the
// incompatibility matrix for the subset we've written up. A curated entry
// naming something absent upstream is dropped, not resurrected — whitelisting
// a name GAM doesn't have would pass validateCombo and then 400 at GAM.
function merge<T>(generated: GeneratedEntry[], curated: Override[]): T[] {
  const byName = new Map(curated.map((c) => [c.name, c]));
  return generated.map((g) => {
    const c = byName.get(g.name);
    return {
      name: g.name,
      type: g.type,
      description: c?.description ?? g.description,
      report_types: g.report_types,
      ...(c?.incompatible_with?.length && { incompatible_with: c.incompatible_with }),
    } as T;
  });
}

export const GAM_SCHEMA: { dimensions: DimensionDef[]; metrics: MetricDef[] } = {
  dimensions: merge<DimensionDef>(GENERATED_DIMENSIONS, CURATED_DIMENSIONS),
  metrics: merge<MetricDef>(GENERATED_METRICS, CURATED_METRICS),
};

const FIELD_TYPES = new Map<string, DimensionDef['type'] | MetricDef['type']>([
  ...GAM_SCHEMA.dimensions.map((d) => [d.name, d.type] as const),
  ...GAM_SCHEMA.metrics.map((m) => [m.name, m.type] as const),
]);

// The schema's declared type for a dimension or metric name, or undefined for
// a name GAM does not have. Used to decode values (dates) and to type columns
// that came back empty.
export function fieldType(name: string): DimensionDef['type'] | MetricDef['type'] | undefined {
  return FIELD_TYPES.get(name);
}

export { REPORT_TYPES };

// Friendly / legacy names that map onto a canonical REST name. GAM's REST v1
// API has no `CREATIVE_SIZE` — the equivalent is RENDERED_CREATIVE_SIZE. We
// accept the familiar name and rewrite it so a caller asking for
// "CREATIVE_SIZE" gets data instead of a 400 from GAM.
export const DIMENSION_ALIASES: Record<string, string> = {
  CREATIVE_SIZE: 'RENDERED_CREATIVE_SIZE',
};

// Map a dimension name to its canonical REST name, or return it unchanged.
export function resolveDimensionAlias(name: string): string {
  return DIMENSION_ALIASES[name] ?? name;
}

const DIMS = new Set(GAM_SCHEMA.dimensions.map((d) => d.name));
const METRICS = new Set(GAM_SCHEMA.metrics.map((m) => m.name));

export function isValidDimension(name: string): boolean {
  return DIMS.has(name);
}
export function isValidMetric(name: string): boolean {
  return METRICS.has(name);
}

export function validateCombo(q: { dimensions: string[]; metrics: string[] }): string | null {
  for (const d of q.dimensions) {
    if (!isValidDimension(d)) return `Unknown dimension: ${d}`;
  }
  for (const m of q.metrics) {
    if (!isValidMetric(m)) return `Unknown metric: ${m}`;
  }
  return null;
}

const DIM_BY_NAME = new Map(GAM_SCHEMA.dimensions.map((d) => [d.name, d]));
const METRIC_BY_NAME = new Map(GAM_SCHEMA.metrics.map((m) => [m.name, m]));

// Returns the curated incompatibilities for a dimension or metric name, or []
// if none are recorded. Symmetric: callers can pass either side.
export function incompatibleWith(name: string): string[] {
  return DIM_BY_NAME.get(name)?.incompatible_with
    ?? METRIC_BY_NAME.get(name)?.incompatible_with
    ?? [];
}

// Report types this MCP has tools and plumbing for. Anything else in
// REPORT_TYPES is still queryable via run_report, but flagged as unproven.
export const SUPPORTED_REPORT_TYPES: ReportType[] = [
  'HISTORICAL',
  'REACH',
  'AD_SPEED',
  'FUTURE_SELL_THROUGH',
  'PRIVACY_AND_MESSAGING',
];

// When a query is compatible with several report types, pick in this order.
// HISTORICAL first because it is the default family and the widest; the rest
// follow the order Google declares them in.
const PREFERENCE: readonly string[] = ['HISTORICAL', ...REPORT_TYPES.filter((t) => t !== 'HISTORICAL')];

export function reportTypesFor(name: string): string[] {
  return DIM_BY_NAME.get(name)?.report_types ?? METRIC_BY_NAME.get(name)?.report_types ?? [];
}

/**
 * Derives the GAM `reportType` a query implies by intersecting the report
 * types every requested metric and dimension is compatible with.
 *
 * GAM computes each report family in a separate pipeline, so a request is
 * wholly one type — asking for reach and historical metrics together 400s.
 * Deriving this rather than accepting it as tool input means the caller never
 * picks, and the report cache (which already keys on the metric list) stays
 * correct without an extra field.
 *
 * Returns {error} naming the conflicting entries when no type accepts them all.
 */
export function resolveReportType(
  metrics: string[],
  dimensions: string[] = [],
): ReportType | { error: string } {
  const named = [...metrics, ...dimensions]
    .map((n) => ({ name: n, types: reportTypesFor(n) }))
    .filter((e) => e.types.length > 0);
  if (named.length === 0) return 'HISTORICAL';

  let intersection = new Set(named[0].types);
  for (const e of named.slice(1)) {
    intersection = new Set([...intersection].filter((t) => e.types.includes(t)));
  }

  if (intersection.size === 0) {
    // Report the split rather than a bare "incompatible": which side to drop
    // is the caller's decision and they need the groupings to make it.
    const groups = new Map<string, string[]>();
    for (const e of named) {
      const key = [...e.types].sort().join('+');
      groups.set(key, [...(groups.get(key) ?? []), e.name]);
    }
    const desc = [...groups.entries()]
      .map(([types, names]) => `${names.join(', ')} → ${types}`)
      .join('; ');
    return {
      error:
        'No single GAM report type accepts all of these together; GAM runs each ' +
        `report family as a separate type. Compatibility: ${desc}. ` +
        'Split into one request per report type',
    };
  }

  return (PREFERENCE.find((t) => intersection.has(t)) ?? [...intersection][0]) as ReportType;
}

// Pre-flight a query against the curated incompatibility matrix. Returns a
// list of conflicts {a, b} (only one direction per pair), or [] if clean.
// The matrix is best-effort — GAM is still the source of truth, so callers
// should treat this as a hint, not a hard validator. Empty result does not
// guarantee GAM will accept the combo.
export function findIncompatibilities(q: {
  dimensions: string[];
  metrics: string[];
}): Array<{ a: string; b: string }> {
  const all = [...q.dimensions, ...q.metrics];
  const seen = new Set<string>();
  const conflicts: Array<{ a: string; b: string }> = [];
  for (const a of all) {
    const bad = new Set(incompatibleWith(a));
    for (const b of all) {
      if (a === b) continue;
      if (!bad.has(b)) continue;
      const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({ a, b });
    }
  }
  return conflicts;
}
