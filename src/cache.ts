import type { ReportQuery, DateRange } from './gam-client.js';

export type CachedRows = Record<string, string>[];

export type ReportCache = {
  get(query: ReportQuery, dateRange: DateRange): CachedRows | undefined;
  set(query: ReportQuery, dateRange: DateRange, rows: CachedRows): void;
  size(): number;
};

// In-process Map keyed by canonicalized query+date_range. Lifetime is the
// MCP server process — perfect for stdio sessions where the LLM iterates
// on adjacent questions and revisits the same time slice multiple times.
// No TTL (queries reflect a closed past period; results don't change), no
// LRU eviction (sessions are short-lived).
export function createReportCache(): ReportCache {
  const store = new Map<string, CachedRows>();
  return {
    get(query, dateRange) {
      return store.get(keyFor(query, dateRange));
    },
    set(query, dateRange, rows) {
      store.set(keyFor(query, dateRange), rows);
    },
    size() { return store.size; },
  };
}

function keyFor(q: ReportQuery, dr: DateRange): string {
  // Sort dims/metrics so callers don't have to. Filters are pre-sorted by
  // (field, op) with their values stringified. custom_dimension_key_ids
  // are positional, so order matters — preserve as-is.
  const dims = [...q.dimensions].sort();
  const metrics = [...q.metrics].sort();
  const filters = (q.filters ?? [])
    .map((f) => ({
      field: f.field,
      op: f.op,
      value: Array.isArray(f.value) ? [...f.value].map(String).sort() : String(f.value),
    }))
    .sort((a, b) => a.field.localeCompare(b.field) || a.op.localeCompare(b.op));
  return JSON.stringify({
    dims,
    metrics,
    filters,
    cdki: q.custom_dimension_key_ids ?? [],
    dr,
  });
}
