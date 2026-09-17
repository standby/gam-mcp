import { describe, it, expect } from 'vitest';
import { canonicalDefinition, definitionHash, reportName, sameDefinition } from '../src/report-key.js';
import { reportDefinition, type ReportDefinition } from '../src/report-definition.js';
import type { DateRange, ReportQuery } from '../src/gam-client.js';

const build = (q: ReportQuery, r: DateRange) => reportDefinition(q, r);

// A query that fills every optional part of a definition.
const QUERY: ReportQuery = {
  dimensions: ['DATE', 'CUSTOM_DIMENSION_0_VALUE', 'CUSTOM_DIMENSION_1_VALUE'],
  metrics: ['IMPRESSIONS', 'REVENUE'],
  filters: [
    { field: 'AD_UNIT_ID', op: 'IN', value: [7, 3] },
    { field: 'COUNTRY_NAME', op: '!=', value: 'Country B' },
  ],
  custom_dimension_key_ids: [111, 222],
  report_type: 'HISTORICAL',
};
const RANGE = { start: '2026-09-01', end: '2026-09-02' };
const full = (): ReportDefinition => build(QUERY, RANGE);

// A different value of the same shape: strings gain a suffix, numbers grow,
// lists gain a changed copy of their first element, objects change their
// first key.
function mutate(v: unknown): unknown {
  if (typeof v === 'string') return `${v}_CHANGED`;
  if (typeof v === 'number') return v + 1;
  if (Array.isArray(v)) return [...v, v.length > 0 ? mutate(v[0]) : 'EXTRA'];
  if (v !== null && typeof v === 'object') {
    const [k] = Object.keys(v);
    return { ...v, [k]: mutate((v as Record<string, unknown>)[k]) };
  }
  throw new Error(`cannot mutate ${String(v)}`);
}

describe('definitionHash (B1)', () => {
  it('uses a fixture that has every key a definition can carry', () => {
    expect(Object.keys(full()).sort()).toEqual([
      'customDimensionKeyIds', 'dateRange', 'dimensions', 'filters', 'metrics', 'reportType',
    ]);
  });

  it.each(Object.keys(full()))('changing %s changes the hash', (key) => {
    const def = full();
    const changed = { ...def, [key]: mutate((def as Record<string, unknown>)[key]) } as ReportDefinition;
    expect(definitionHash(changed)).not.toBe(definitionHash(def));
    expect(sameDefinition(changed, def)).toBe(false);
  });

  it('ignores the order of dimensions, metrics, filters and the values in a filter', () => {
    const def = full();
    const shuffled: ReportDefinition = {
      ...def,
      dimensions: [...def.dimensions].reverse(),
      metrics: [...def.metrics].reverse(),
      filters: [...def.filters!].reverse().map((f) => {
        const ff = (f as { fieldFilter: { values: unknown[] } }).fieldFilter;
        return { fieldFilter: { ...ff, values: [...ff.values].reverse() } };
      }),
    };
    expect(definitionHash(shuffled)).toBe(definitionHash(def));
    expect(sameDefinition(shuffled, def)).toBe(true);
  });

  it('keeps customDimensionKeyIds positional', () => {
    const def = full();
    const swapped = { ...def, customDimensionKeyIds: [...def.customDimensionKeyIds!].reverse() };
    expect(definitionHash(swapped)).not.toBe(definitionHash(def));
  });

  it('ignores object key order and a missing empty list, as a definition read back from GAM has them', () => {
    const def = build({ dimensions: [], metrics: ['IMPRESSIONS'] }, RANGE);
    const echoed = Object.fromEntries(
      Object.entries(def).filter(([k]) => k !== 'dimensions').reverse(),
    ) as unknown as ReportDefinition;
    expect(definitionHash(echoed)).toBe(definitionHash(def));
    expect(sameDefinition(echoed, def)).toBe(true);
  });

  it('is a SHA-256 in hex', () => {
    expect(definitionHash(full())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('reportName (E7)', () => {
  it('is "gam-mcp " and the first 16 hex characters of the hash', () => {
    const hash = definitionHash(full());
    expect(reportName(hash)).toBe(`gam-mcp ${hash.slice(0, 16)}`);
  });
});

describe('canonicalDefinition', () => {
  it('writes keys in sorted order at every depth', () => {
    const sortedEverywhere = (v: unknown): boolean => {
      if (Array.isArray(v)) return v.every(sortedEverywhere);
      if (v === null || typeof v !== 'object') return true;
      const keys = Object.keys(v);
      return keys.join() === [...keys].sort().join() && Object.values(v).every(sortedEverywhere);
    };
    expect(sortedEverywhere(canonicalDefinition(full()))).toBe(true);
  });
});
