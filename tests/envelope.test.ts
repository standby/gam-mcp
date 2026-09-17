import { describe, it, expect } from 'vitest';
import { envelope, inferSchema, listEnvelope } from '../src/envelope.js';

describe('envelope', () => {
  it('writes every qualifier before the rows (spec §1.1)', () => {
    const e = envelope({
      summary: 's',
      provenance: {
        network_code: '1234', report_type: 'HISTORICAL', report: 'r', result: 'r/results/1',
        run_time: null, date_range: null, date_time_zone: 'UTC', dimensions: [], metrics: [],
        filters: [], sort: [], cache: { hit: false },
      },
      total_row_count: 3,
      truncated: true,
      next_cursor: 'c',
      warnings: ['w'],
      schema: [{ name: 'A', type: 'integer' }],
      rows: [{ A: 1 }],
    });
    expect(Object.keys(e)).toEqual([
      'summary', 'provenance', 'total_row_count', 'returned_row_count',
      'truncated', 'next_cursor', 'warnings', 'schema', 'rows',
    ]);
    expect(e.returned_row_count).toBe(1);
    const text = JSON.stringify(e);
    for (const key of ['"provenance"', '"total_row_count"', '"truncated"', '"warnings"']) {
      expect(text.indexOf(key)).toBeLessThan(text.indexOf('"rows"'));
    }
  });
});

describe('listEnvelope', () => {
  it('wraps non-report rows with the same keys and no provenance', () => {
    const e = listEnvelope([{ name: 'x', n: 2, ok: true, gone: null }], 'Listed.');
    expect(Object.keys(e)).toEqual([
      'summary', 'total_row_count', 'returned_row_count', 'truncated', 'next_cursor', 'warnings', 'schema', 'rows',
    ]);
    expect(e).toMatchObject({ total_row_count: 1, returned_row_count: 1, truncated: false, next_cursor: null, warnings: [] });
    expect(e.schema).toEqual([
      { name: 'name', type: 'string' },
      { name: 'n', type: 'number' },
      { name: 'ok', type: 'boolean' },
      { name: 'gone', type: 'string' },
    ]);
  });

  it('uses a given schema as-is', () => {
    const e = listEnvelope([], 'Empty.', [{ name: 'kind', type: 'string' }]);
    expect(e.schema).toEqual([{ name: 'kind', type: 'string' }]);
    expect(inferSchema([])).toEqual([]);
  });
});
