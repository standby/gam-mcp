import { createHash } from 'node:crypto';
import type { ReportDefinition } from './report-definition.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Object keys sorted at every depth, so key order never changes the text.
function sortKeys(v: unknown): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: { [key: string]: Json } = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v as Json;
}

const text = (v: unknown): string => JSON.stringify(sortKeys(v));

function byText(a: unknown, b: unknown): number {
  const x = text(a);
  const y = text(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// A filter with the values inside it in a fixed order.
function normalizeFilter(f: unknown): unknown {
  const field = (f as { fieldFilter?: { values?: unknown } } | null)?.fieldFilter;
  if (!field || !Array.isArray(field.values)) return f;
  return { ...(f as object), fieldFilter: { ...field, values: [...field.values].sort(byText) } };
}

// The form of a definition that is hashed and compared (spec §2.2). GAM
// returns each row's values in the order of the report's dimensions and
// metrics, so those keep their order: a report with its columns in another
// order is another report, and its rows cannot be read with ours. GAM gives no
// meaning to the order of filters or of the values inside a filter, so those
// are sorted. customDimensionKeyIds are positional (slot N is
// CUSTOM_DIMENSION_N_VALUE) and every other list keeps its order too. Absent
// fields and empty lists are dropped: GAM's JSON omits empty lists, so a
// definition read back from GAM has none.
export function canonicalDefinition(def: ReportDefinition): Json {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(def)) {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) continue;
    if (key === 'filters') out[key] = (value as unknown[]).map(normalizeFilter).sort(byText);
    else out[key] = value;
  }
  return sortKeys(out);
}

// SHA-256 of the canonical definition. It is the result-cache key and the
// source of the report name: both come from this one function (test E7).
export function definitionHash(def: ReportDefinition): string {
  return createHash('sha256').update(JSON.stringify(canonicalDefinition(def))).digest('hex');
}

// The displayName of the report that runs a definition, so any process can
// find that report again by listing the name (spec §2.2).
export function reportName(hash: string): string {
  return `gam-mcp ${hash.slice(0, 16)}`;
}

export function sameDefinition(a: ReportDefinition, b: ReportDefinition): boolean {
  return JSON.stringify(canonicalDefinition(a)) === JSON.stringify(canonicalDefinition(b));
}
