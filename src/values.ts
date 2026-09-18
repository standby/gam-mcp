import { fieldType } from './schema.js';

// GAM's ReportValue union (Ad Manager API v1). int64 values arrive as JSON
// strings; proto3 JSON omits unset fields, so an empty object means "no value".
export type ReportValue = {
  intValue?: string;
  doubleValue?: number;
  stringValue?: string;
  boolValue?: boolean;
  bytesValue?: string;
  intListValue?: { values?: string[] };
  doubleListValue?: { values?: number[] };
  stringListValue?: { values?: string[] };
};

export type ReportRow = {
  dimensionValues?: ReportValue[];
  metricValueGroups?: { primaryValues?: ReportValue[] }[];
};

export type Scalar = string | number | boolean;
export type Cell = Scalar | Scalar[] | null;
export type ColumnType = 'integer' | 'number' | 'string' | 'boolean' | 'date' | 'array' | 'bytes' | 'object';
export type Column = { name: string; type: ColumnType };
export type Table = { columns: Column[]; rows: Record<string, Cell>[]; warnings: string[] };

type Converted = { value: Cell; type: ColumnType | null; unsafeInteger: boolean };

const NONE: Converted = { value: null, type: null, unsafeInteger: false };
const YYYYMMDD = /^\d{8}$/;

function integer(s: string): { value: number | string; unsafe: boolean } {
  const n = Number(s);
  return Number.isSafeInteger(n) ? { value: n, unsafe: false } : { value: s, unsafe: true };
}

export function convertValue(v: ReportValue | null | undefined, isDateColumn: boolean): Converted {
  if (!v) return NONE;
  if (v.intValue !== undefined) {
    // GAM's own JSON sends int64 as a string, but a value that passed through
    // a JSON round-trip elsewhere (e.g. a test fixture, or a proxy that
    // re-serializes) can arrive as a JS number. Normalise once before the
    // date check and integer(), both of which need string operations.
    const s = String(v.intValue);
    if (isDateColumn && YYYYMMDD.test(s)) {
      return { value: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, type: 'date', unsafeInteger: false };
    }
    const { value, unsafe } = integer(s);
    return { value, type: 'integer', unsafeInteger: unsafe };
  }
  if (v.doubleValue !== undefined) {
    // proto3 JSON writes NaN/Infinity as strings; they are not numbers a reader can use.
    return typeof v.doubleValue === 'number' && Number.isFinite(v.doubleValue)
      ? { value: v.doubleValue, type: 'number', unsafeInteger: false }
      : NONE;
  }
  if (v.stringValue !== undefined) {
    return { value: v.stringValue, type: isDateColumn ? 'date' : 'string', unsafeInteger: false };
  }
  if (v.boolValue !== undefined) return { value: v.boolValue, type: 'boolean', unsafeInteger: false };
  if (v.bytesValue !== undefined) return { value: v.bytesValue, type: 'bytes', unsafeInteger: false };
  if (v.intListValue) {
    const parts = (v.intListValue.values ?? []).map(integer);
    return { value: parts.map((p) => p.value), type: 'array', unsafeInteger: parts.some((p) => p.unsafe) };
  }
  if (v.doubleListValue) return { value: [...(v.doubleListValue.values ?? [])], type: 'array', unsafeInteger: false };
  if (v.stringListValue) return { value: [...(v.stringListValue.values ?? [])], type: 'array', unsafeInteger: false };
  return NONE;
}

const FALLBACK: Record<string, ColumnType> = {
  string: 'string',
  number: 'number',
  date: 'date',
  currency: 'number',
  rate: 'number',
};

// Columns are named from the report definition (dimensions, then metrics),
// never from process memory, so a restarted server still labels them.
export function buildTable(dimensions: string[], metrics: string[], rows: ReportRow[]): Table {
  const names = [...dimensions, ...metrics];
  const dateColumn = names.map((n) => fieldType(n) === 'date');
  const types: (ColumnType | null)[] = names.map(() => null);
  const unsafe = new Set<string>();
  let mismatchedCounts = false;

  const out = rows.map((row) => {
    // Dimensions and metrics are indexed from their own arrays, never
    // concatenated: a short dimensionValues array must not shift a metric
    // value into a dimension column.
    const dimValues = row.dimensionValues ?? [];
    const metValues = row.metricValueGroups?.[0]?.primaryValues ?? [];
    if (dimValues.length !== dimensions.length || metValues.length !== metrics.length) {
      mismatchedCounts = true;
    }
    const record: Record<string, Cell> = {};
    const assign = (name: string, i: number, raw: ReportValue | undefined) => {
      const c = convertValue(raw, dateColumn[i]);
      record[name] = c.value;
      if (c.type && !types[i]) types[i] = c.type;
      if (c.unsafeInteger) unsafe.add(name);
    };
    dimensions.forEach((name, i) => assign(name, i, dimValues[i]));
    metrics.forEach((name, j) => assign(name, dimensions.length + j, metValues[j]));
    return record;
  });

  const columns = names.map((name, i) => ({
    name,
    type: types[i] ?? FALLBACK[fieldType(name) ?? 'string'] ?? 'string',
  }));
  const warnings = [...unsafe].map(
    (n) => `Column ${n} holds integers beyond ±2^53; those values are strings so they stay exact.`,
  );
  if (mismatchedCounts) {
    warnings.push("GAM returned rows whose value counts do not match the report's columns; missing values are null.");
  }
  return { columns, rows: out, warnings };
}

// Text form of a cell, for map keys and labels. A missing value is the empty
// string here only because keys need a string; arithmetic must not use this.
export function cellText(c: Cell | undefined): string {
  if (c === null || c === undefined) return '';
  return Array.isArray(c) ? c.join(',') : String(c);
}
