import { describe, it, expect } from 'vitest';
import { buildTable, cellText, convertValue } from '../src/values.js';
import { fieldType } from '../src/schema.js';

describe('fieldType', () => {
  it('knows dimension and metric types from the schema', () => {
    expect(fieldType('DATE')).toBe('date');
    expect(fieldType('LINE_ITEM_START_DATE')).toBe('date');
    expect(fieldType('AD_UNIT_NAME')).toBe('string');
    expect(fieldType('REVENUE')).toBe('currency');
    expect(fieldType('NOT_A_FIELD')).toBeUndefined();
  });
});

describe('convertValue', () => {
  it('maps each GAM value kind to a typed cell', () => {
    expect(convertValue({ intValue: '4791253' }, false)).toEqual({ value: 4791253, type: 'integer', unsafeInteger: false });
    expect(convertValue({ doubleValue: 41937.904096211954 }, false)).toEqual({ value: 41937.904096211954, type: 'number', unsafeInteger: false });
    expect(convertValue({ stringValue: 'Example' }, false)).toEqual({ value: 'Example', type: 'string', unsafeInteger: false });
    expect(convertValue({ boolValue: false }, false)).toEqual({ value: false, type: 'boolean', unsafeInteger: false });
    expect(convertValue({ bytesValue: 'AAE=' }, false)).toEqual({ value: 'AAE=', type: 'bytes', unsafeInteger: false });
    expect(convertValue({ intListValue: { values: ['1', '2'] } }, false)).toEqual({ value: [1, 2], type: 'array', unsafeInteger: false });
    expect(convertValue({ doubleListValue: { values: [0.5] } }, false)).toEqual({ value: [0.5], type: 'array', unsafeInteger: false });
    expect(convertValue({ stringListValue: { values: ['a'] } }, false)).toEqual({ value: ['a'], type: 'array', unsafeInteger: false });
  });

  it('never turns a missing value into zero or an empty string', () => {
    expect(convertValue(undefined, false)).toEqual({ value: null, type: null, unsafeInteger: false });
    expect(convertValue(null, false)).toEqual({ value: null, type: null, unsafeInteger: false });
    expect(convertValue({}, false)).toEqual({ value: null, type: null, unsafeInteger: false });
  });

  it('keeps integers beyond 2^53 exact as strings and says so', () => {
    expect(convertValue({ intValue: '9007199254740993' }, false)).toEqual({ value: '9007199254740993', type: 'integer', unsafeInteger: true });
    expect(convertValue({ intListValue: { values: ['1', '9007199254740993'] } }, false)).toEqual({ value: [1, '9007199254740993'], type: 'array', unsafeInteger: true });
  });

  it('turns YYYYMMDD integers into ISO dates only for date columns', () => {
    expect(convertValue({ intValue: '20260915' }, true)).toEqual({ value: '2026-09-15', type: 'date', unsafeInteger: false });
    expect(convertValue({ intValue: '20260915' }, false)).toEqual({ value: 20260915, type: 'integer', unsafeInteger: false });
    expect(convertValue({ stringValue: '2026-09-15T00:00:00Z' }, true)).toEqual({ value: '2026-09-15T00:00:00Z', type: 'date', unsafeInteger: false });
  });

  it('treats a non-finite double as missing', () => {
    expect(convertValue({ doubleValue: 'NaN' as unknown as number }, false)).toEqual({ value: null, type: null, unsafeInteger: false });
  });
});

describe('buildTable', () => {
  it('names columns from the definition and types them from the values', () => {
    const t = buildTable(['ADVERTISER_ID', 'ADVERTISER_NAME'], ['IMPRESSIONS', 'REVENUE'], [
      { dimensionValues: [{ intValue: '7' }, { stringValue: 'A' }], metricValueGroups: [{ primaryValues: [{ intValue: '10' }, { doubleValue: 1.5 }] }] },
      { dimensionValues: [{ intValue: '8' }, {}], metricValueGroups: [{ primaryValues: [{}, { doubleValue: 2 }] }] },
    ]);
    expect(t.columns).toEqual([
      { name: 'ADVERTISER_ID', type: 'integer' },
      { name: 'ADVERTISER_NAME', type: 'string' },
      { name: 'IMPRESSIONS', type: 'integer' },
      { name: 'REVENUE', type: 'number' },
    ]);
    expect(t.rows).toEqual([
      { ADVERTISER_ID: 7, ADVERTISER_NAME: 'A', IMPRESSIONS: 10, REVENUE: 1.5 },
      { ADVERTISER_ID: 8, ADVERTISER_NAME: null, IMPRESSIONS: null, REVENUE: 2 },
    ]);
    expect(t.warnings).toEqual([]);
  });

  it('falls back to the schema type when a column has no values', () => {
    const t = buildTable(['DATE'], ['REVENUE'], []);
    expect(t.columns).toEqual([{ name: 'DATE', type: 'date' }, { name: 'REVENUE', type: 'number' }]);
  });

  it('warns once per column holding unsafe integers', () => {
    const t = buildTable([], ['IMPRESSIONS'], [
      { metricValueGroups: [{ primaryValues: [{ intValue: '9007199254740993' }] }] },
      { metricValueGroups: [{ primaryValues: [{ intValue: '9007199254740995' }] }] },
    ]);
    expect(t.warnings).toEqual(['Column IMPRESSIONS holds integers beyond ±2^53; those values are strings so they stay exact.']);
  });
});

describe('cellText', () => {
  it('renders cells as text for keys and labels', () => {
    expect(cellText(7)).toBe('7');
    expect(cellText('a')).toBe('a');
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
    expect(cellText([1, 'b'])).toBe('1,b');
    expect(cellText(true)).toBe('true');
  });
});
