import { describe, it, expect } from 'vitest';
import { definitionRange, reportDefinition, toReportFilters, type ReportDefinition } from '../src/report-definition.js';
import type { DateRange, ReportQuery } from '../src/gam-client.js';

const USD = { currencyCode: 'USD' };
const build = (q: ReportQuery, r: DateRange) => reportDefinition(q, r, USD);
const RANGE = { start: '2026-04-01', end: '2026-04-29' };

describe('reportDefinition', () => {
  it('builds the body GAM receives', () => {
    expect(build({ dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] }, RANGE)).toEqual({
      dimensions: ['ADVERTISER_NAME'],
      metrics: ['IMPRESSIONS'],
      dateRange: { fixed: { startDate: { year: 2026, month: 4, day: 1 }, endDate: { year: 2026, month: 4, day: 29 } } },
      reportType: 'HISTORICAL',
      timeZoneSource: 'PUBLISHER',
      currencyCode: 'USD',
    });
  });

  it('D5: never asks for a provided time zone, and uses the currency it is given', () => {
    // A currency the fake network does not use, so this proves the given
    // currency is used rather than the network's default.
    const d = reportDefinition({ dimensions: ['DATE'], metrics: ['IMPRESSIONS'] }, RANGE, { currencyCode: 'EUR' });
    expect(d).not.toHaveProperty('timeZone');
    expect(d.timeZoneSource).toBe('PUBLISHER');
    expect(d.currencyCode).toBe('EUR');
  });

  it('forwards report_type so reach metrics run as a REACH report', () => {
    const d = build({ dimensions: ['LINE_ITEM_NAME'], metrics: ['UNIQUE_VISITORS'], report_type: 'REACH' }, RANGE);
    expect(d.reportType).toBe('REACH');
  });

  it('encodes filters in GAM REST shape: IN/NOT_IN for = and !=, values always a list, int64 as strings', () => {
    const d = build({
      dimensions: ['AD_UNIT_NAME'],
      metrics: ['IMPRESSIONS'],
      filters: [
        { field: 'AD_UNIT_NAME', op: '=', value: 'Foo' },
        { field: 'AD_UNIT_ID', op: 'IN', value: [1, 2, 3] },
        { field: 'COUNTRY_NAME', op: '!=', value: 'XX' },
      ],
    }, RANGE);
    expect(d).not.toHaveProperty('filter');
    expect(d.filters).toEqual([
      { fieldFilter: { field: { dimension: 'AD_UNIT_NAME' }, operation: 'IN', values: [{ stringValue: 'Foo' }] } },
      { fieldFilter: { field: { dimension: 'AD_UNIT_ID' }, operation: 'IN', values: [{ intValue: '1' }, { intValue: '2' }, { intValue: '3' }] } },
      { fieldFilter: { field: { dimension: 'COUNTRY_NAME' }, operation: 'NOT_IN', values: [{ stringValue: 'XX' }] } },
    ]);
  });

  it('encodes CONTAINS and NOT_CONTAINS directly', () => {
    const d = build({
      dimensions: ['AD_UNIT_NAME'],
      metrics: ['IMPRESSIONS'],
      filters: [
        { field: 'AD_UNIT_NAME', op: 'CONTAINS', value: 'nimbus' },
        { field: 'AD_UNIT_NAME', op: 'NOT_CONTAINS', value: 'house' },
      ],
    }, RANGE);
    expect(d.filters).toEqual([
      { fieldFilter: { field: { dimension: 'AD_UNIT_NAME' }, operation: 'CONTAINS', values: [{ stringValue: 'nimbus' }] } },
      { fieldFilter: { field: { dimension: 'AD_UNIT_NAME' }, operation: 'NOT_CONTAINS', values: [{ stringValue: 'house' }] } },
    ]);
  });

  it('passes custom_dimension_key_ids through as strings, in order', () => {
    const d = build({
      dimensions: ['CUSTOM_DIMENSION_0_VALUE', 'CUSTOM_DIMENSION_1_VALUE', 'DATE'],
      metrics: ['IMPRESSIONS'],
      custom_dimension_key_ids: [98765, 12],
    }, RANGE);
    expect(d.customDimensionKeyIds).toEqual(['98765', '12']);
  });

  it('omits filters, customDimensionKeyIds and sorts when there are none', () => {
    const d = build(
      { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'], filters: [], custom_dimension_key_ids: [] }, RANGE,
    );
    expect(d).not.toHaveProperty('filters');
    expect(d).not.toHaveProperty('filter');
    expect(d).not.toHaveProperty('customDimensionKeyIds');
    expect(d).not.toHaveProperty('sorts');
  });

  it('rejects a filter with an empty value list', () => {
    expect(() => toReportFilters([{ field: 'AD_UNIT_ID', op: 'IN', value: [] }])).toThrow('filter value list is empty');
  });
});

describe('definitionRange', () => {
  it('reads the fixed range back as ISO dates', () => {
    const d = build({ dimensions: ['DATE'], metrics: ['IMPRESSIONS'] }, { start: '2026-02-03', end: '2026-12-31' });
    expect(definitionRange(d)).toEqual({ start: '2026-02-03', end: '2026-12-31' });
  });

  it('is null for a definition without a fixed range', () => {
    const stored = { dimensions: [], metrics: ['IMPRESSIONS'], reportType: 'HISTORICAL' } as unknown as ReportDefinition;
    expect(definitionRange(stored)).toBeNull();
  });
});
