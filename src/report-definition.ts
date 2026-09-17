import type { DateRange, NetworkInfo, ReportQuery } from './gam-client.js';

export type GamDate = { year: number; month: number; day: number };

// The reportDefinition object GAM receives, in GAM's own shape. Provenance
// copies filters and sorts from here, so what a result claims is what ran.
export type ReportDefinition = {
  dimensions: string[];
  metrics: string[];
  dateRange: { fixed: { startDate: GamDate; endDate: GamDate } };
  reportType: string;
  filters?: unknown[];
  customDimensionKeyIds?: string[];
  // GAM's sort order, copied into provenance.sort. PR 4's top_n tools set it
  // (spec §4.2); a definition read back from GAM carries whatever it stored.
  sorts?: unknown[];
  // Optional because a definition read back from GAM may lack them; every
  // definition this server builds sets both (spec §2.4).
  timeZoneSource?: string;
  currencyCode?: string;
};

function toDateParts(iso: string): GamDate {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

// A GAM date read back from a stored definition may have missing parts (proto3
// JSON omits zero fields); undefined in, undefined out, so callers never dress
// absence up as an empty string.
export function isoDate(d: Partial<GamDate> | undefined): string | undefined {
  if (!d?.year || !d.month || !d.day) return undefined;
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export function reportDefinition(
  query: ReportQuery,
  dateRange: DateRange,
  network: Pick<NetworkInfo, 'currencyCode'>,
): ReportDefinition {
  return {
    dimensions: query.dimensions,
    metrics: query.metrics,
    dateRange: {
      fixed: {
        startDate: toDateParts(dateRange.start),
        endDate: toDateParts(dateRange.end),
      },
    },
    reportType: query.report_type ?? 'HISTORICAL',
    ...(query.filters?.length && { filters: toReportFilters(query.filters) }),
    // GAM expects int64 IDs as strings. Index here = slot number on
    // CUSTOM_DIMENSION_<N>_VALUE dimensions.
    ...(query.custom_dimension_key_ids?.length && {
      customDimensionKeyIds: query.custom_dimension_key_ids.map(String),
    }),
    // GAM rejects a PROVIDED zone for ordinary reports (live probe,
    // 2026-09-17), so every report is computed in the network's own zone.
    timeZoneSource: 'PUBLISHER',
    currencyCode: network.currencyCode,
  };
}

// The fixed range a definition asks for, or null when it has none (a report
// created elsewhere may use a relative range).
export function definitionRange(def: ReportDefinition): DateRange | null {
  const fixed = def.dateRange?.fixed;
  const start = isoDate(fixed?.startDate);
  const end = isoDate(fixed?.endDate);
  if (!start || !end) return null;
  return { start, end };
}

// GAM REST Reports API expects structured filters wrapped in
// { fieldFilter: { field: {dimension}, operation, values: ReportValue[] } }.
// Notable quirks captured here once so callers don't have to know them:
//   - GAM has no EQUALS / NOT_EQUALS operators; `=` and `!=` are expressed as
//     IN / NOT_IN with a single-element values array.
//   - `values` is always an array, even for single-value comparisons.
//   - `intValue` is a JSON string (Google's int64 → JSON convention).
//   - The dimension is on `field.dimension`, not `field.name`.
const OP_TO_OPERATION: Record<'=' | 'IN' | '!=' | 'CONTAINS' | 'NOT_CONTAINS',
  'IN' | 'NOT_IN' | 'CONTAINS' | 'NOT_CONTAINS'> = {
  '=': 'IN',
  'IN': 'IN',
  '!=': 'NOT_IN',
  'CONTAINS': 'CONTAINS',
  'NOT_CONTAINS': 'NOT_CONTAINS',
};

export function toReportFilters(filters: NonNullable<ReportQuery['filters']>): unknown[] {
  return filters.map((f) => {
    const list = Array.isArray(f.value) ? f.value : [f.value];
    if (list.length === 0) throw new Error('filter value list is empty');
    return {
      fieldFilter: {
        field: { dimension: f.field },
        operation: OP_TO_OPERATION[f.op],
        values: list.map(toReportValue),
      },
    };
  });
}

function toReportValue(v: number | string): unknown {
  return typeof v === 'number' ? { intValue: String(v) } : { stringValue: v };
}
