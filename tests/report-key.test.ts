import { describe, it, expect } from 'vitest';
import { canonicalDefinition, definitionHash, differingKeys, reportName, sameDefinition } from '../src/report-key.js';
import { reportDefinition, type ReportDefinition } from '../src/report-definition.js';
import type { DateRange, ReportQuery } from '../src/gam-client.js';
import { TEST_NETWORK } from './helpers.js';

const build = (q: ReportQuery, r: DateRange) => reportDefinition(q, r, TEST_NETWORK);

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
  sort: { metric: 'IMPRESSIONS', descending: true },
};
const RANGE = { start: '2026-09-01', end: '2026-09-02' };
// reportDefinition only ever sets one sort from a query (a top_n tool asks
// for exactly one). B1's positional test needs a second entry -- a primary
// and a tiebreak -- to mean anything, so it is appended directly here.
const full = (): ReportDefinition => {
  const def = build(QUERY, RANGE);
  return { ...def, sorts: [...(def.sorts ?? []), { field: { metric: 'REVENUE' }, descending: false }] };
};

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
      'currencyCode', 'customDimensionKeyIds', 'dateRange', 'dimensions', 'filters', 'metrics', 'reportType', 'sorts', 'timeZoneSource',
    ]);
  });

  it.each(Object.keys(full()))('changing %s changes the hash', (key) => {
    const def = full();
    const changed = { ...def, [key]: mutate((def as Record<string, unknown>)[key]) } as ReportDefinition;
    expect(definitionHash(changed)).not.toBe(definitionHash(def));
    expect(sameDefinition(changed, def)).toBe(false);
  });

  // GAM returns values in the order of the report's columns, so a report with
  // its columns in another order is another report.
  it.each(['dimensions', 'metrics'] as const)('reordering %s changes the hash', (key) => {
    const def = full();
    const reordered: ReportDefinition = { ...def, [key]: [...def[key]].reverse() };
    expect(definitionHash(reordered)).not.toBe(definitionHash(def));
    expect(sameDefinition(reordered, def)).toBe(false);
  });

  it('ignores the order of filters and of the values in an IN or NOT_IN filter', () => {
    const def = full();
    const shuffled: ReportDefinition = {
      ...def,
      filters: [...def.filters!].reverse().map((f) => {
        const ff = (f as { fieldFilter: { values: unknown[] } }).fieldFilter;
        return { fieldFilter: { ...ff, values: [...ff.values].reverse() } };
      }),
    };
    expect(definitionHash(shuffled)).toBe(definitionHash(def));
    expect(sameDefinition(shuffled, def)).toBe(true);
  });

  // One filter on DATE with the given operation and values.
  const withFilter = (operation: string, values: unknown[]): ReportDefinition => ({
    ...full(),
    filters: [{ fieldFilter: { field: { dimension: 'DATE' }, operation, values } }],
  });
  const days = [{ intValue: '20260901' }, { intValue: '20260902' }];

  it('tells IN and NOT_IN apart on the same values', () => {
    expect(definitionHash(withFilter('IN', days))).not.toBe(definitionHash(withFilter('NOT_IN', days)));
  });

  // The values of these operations form a set.
  it.each(['IN', 'NOT_IN', 'CONTAINS', 'NOT_CONTAINS'])('ignores the order of a %s list', (operation) => {
    const reversed = withFilter(operation, [...days].reverse());
    expect(definitionHash(reversed)).toBe(definitionHash(withFilter(operation, days)));
    expect(sameDefinition(reversed, withFilter(operation, days))).toBe(true);
  });

  // Other operations' values are positional: BETWEEN's are its lower and upper bound.
  it('keeps the order of a BETWEEN pair', () => {
    const reversed = withFilter('BETWEEN', [...days].reverse());
    expect(definitionHash(reversed)).not.toBe(definitionHash(withFilter('BETWEEN', days)));
    expect(sameDefinition(reversed, withFilter('BETWEEN', days))).toBe(false);
  });

  it('keeps customDimensionKeyIds positional', () => {
    const def = full();
    const swapped = { ...def, customDimensionKeyIds: [...def.customDimensionKeyIds!].reverse() };
    expect(definitionHash(swapped)).not.toBe(definitionHash(def));
  });

  it('B1: sort order is positional — reversing sorts changes the hash', () => {
    const def = full();
    const reversed = { ...def, sorts: [...(def.sorts as unknown[])].reverse() };
    expect(definitionHash(reversed)).not.toBe(definitionHash(def));
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

describe('differingKeys', () => {
  it('names the top-level keys whose canonical values differ, and only those', () => {
    const def = full();
    expect(differingKeys(def, { ...def, filters: [...def.filters!].reverse() })).toEqual([]);
    const { customDimensionKeyIds: _, ...withoutIds } = def;
    expect(differingKeys(def, { ...withoutIds, metrics: ['AD_REQUESTS'], reportType: 'REACH' }))
      .toEqual(['customDimensionKeyIds', 'metrics', 'reportType']);
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
