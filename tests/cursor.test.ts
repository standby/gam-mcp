import { describe, it, expect } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/cursor.js';

const base = {
  result: 'networks/1234/reports/5/results/6',
  page_token: 'tok',
  offset: 5000,
  total_row_count: 12000,
  run_time: '2026-09-03T01:00:00Z',
  date_range: { start: '2026-09-01', end: '2026-09-02' },
};

describe('cursor', () => {
  it('round-trips and is URL-safe', () => {
    const text = encodeCursor(base);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(text, '1234')).toEqual({ v: 1, ...base });
  });

  it('accepts an unreported total and date range', () => {
    const text = encodeCursor({ ...base, total_row_count: null, run_time: null, date_range: null });
    expect(decodeCursor(text, '1234')).toMatchObject({ total_row_count: null, date_range: null });
  });

  it.each([
    ['another network', encodeCursor({ ...base, result: 'networks/9999/reports/5/results/6' })],
    ['a non-result path', encodeCursor({ ...base, result: 'networks/1234/orders/5' })],
    ['an empty page token', encodeCursor({ ...base, page_token: '' })],
    ['a negative offset', encodeCursor({ ...base, offset: -1 })],
    ['not base64url', 'abc$%'],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['a wrong version', Buffer.from(JSON.stringify({ ...base, v: 2 })).toString('base64url')],
  ])('rejects %s', (_label, text) => {
    expect(decodeCursor(text, '1234')).toHaveProperty('error');
  });
});
