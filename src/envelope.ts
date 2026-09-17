import type { Column, ColumnType } from './values.js';

export type DateSpan = { start: string; end: string };

// What a single report result can say about itself (spec §1.1). Filters and
// sort are copied from the definition GAM ran, in GAM's shapes.
export type Provenance = {
  network_code: string;
  report_type: string;
  report: string;
  result: string;
  run_time: string | null;
  date_range: DateSpan | null;
  // The zone GAM counted every day of this result in, from the definition's
  // time zone source: the network's zone for every report this server
  // creates; null when a report made elsewhere uses a zone this server
  // cannot name.
  report_time_zone: string | null;
  // GAM_TIMEZONE: the zone in which the requested dates were chosen.
  date_time_zone: string;
  // From the definition GAM ran; null for a report that did not name one.
  currency_code: string | null;
  dimensions: string[];
  metrics: string[];
  filters: unknown[];
  sort: unknown[];
  cache: { hit: boolean };
};

export type InputReport = {
  report: string;
  result: string;
  run_time: string | null;
  date_range: DateSpan | null;
};

// Tools that compute from rows name every report they read (spec §1.4).
export type DerivedProvenance = {
  network_code: string;
  report_time_zone: string;
  date_time_zone: string;
  currency_code: string;
  inputs: InputReport[];
};

export type ResultEnvelope = {
  summary: string;
  provenance?: Provenance | DerivedProvenance;
  total_row_count: number | null;
  returned_row_count: number;
  truncated: boolean;
  next_cursor: string | null;
  warnings: string[];
  schema: Column[];
  rows: Record<string, unknown>[];
};

// The only place an envelope is assembled. Key order is the contract:
// everything that qualifies the rows is written before them, so a consumer
// that truncates the serialized text loses rows, not caveats.
export function envelope(p: {
  summary: string;
  provenance?: Provenance | DerivedProvenance;
  total_row_count: number | null;
  truncated: boolean;
  next_cursor: string | null;
  warnings: string[];
  schema: Column[];
  rows: Record<string, unknown>[];
}): ResultEnvelope {
  return {
    summary: p.summary,
    ...(p.provenance && { provenance: p.provenance }),
    total_row_count: p.total_row_count,
    returned_row_count: p.rows.length,
    truncated: p.truncated,
    next_cursor: p.next_cursor,
    warnings: p.warnings,
    schema: p.schema,
    rows: p.rows,
  };
}

function typeOf(v: unknown): ColumnType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'array';
  return 'string';
}

export function inferSchema(rows: Record<string, unknown>[]): Column[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first).map((name) => ({
    name,
    type: typeOf(rows.find((r) => r[name] !== null && r[name] !== undefined)?.[name]),
  }));
}

// For tools whose rows are not a GAM report (lookups, schema, stats).
export function listEnvelope(
  rows: Record<string, unknown>[],
  summary: string,
  schema?: Column[],
): ResultEnvelope {
  return envelope({
    summary,
    total_row_count: rows.length,
    truncated: false,
    next_cursor: null,
    warnings: [],
    schema: schema ?? inferSchema(rows),
    rows,
  });
}
