import { describe, it, expect } from 'vitest';
import { resolveDateRange, type DateRange } from '../src/dates.js';

const NOW = new Date('2026-04-30T14:00:00Z'); // network TZ America/Los_Angeles → 2026-04-30 07:00 local
const TZ = 'America/Los_Angeles';

describe('resolveDateRange', () => {
  it('passes through absolute ranges', () => {
    const r = resolveDateRange({ start: '2026-04-01', end: '2026-04-29' }, TZ, NOW);
    expect(r).toEqual({ start: '2026-04-01', end: '2026-04-29' });
  });

  it('resolves yesterday', () => {
    const r = resolveDateRange({ relative: 'yesterday' }, TZ, NOW);
    expect(r).toEqual({ start: '2026-04-29', end: '2026-04-29' });
  });

  it('resolves last_7_days as 7 full days ending yesterday', () => {
    const r = resolveDateRange({ relative: 'last_7_days' }, TZ, NOW);
    expect(r).toEqual({ start: '2026-04-23', end: '2026-04-29' });
  });

  it('resolves last_full_month', () => {
    const r = resolveDateRange({ relative: 'last_full_month' }, TZ, NOW);
    expect(r).toEqual({ start: '2026-03-01', end: '2026-03-31' });
  });

  it('resolves month_to_date through yesterday', () => {
    const r = resolveDateRange({ relative: 'month_to_date' }, TZ, NOW);
    expect(r).toEqual({ start: '2026-04-01', end: '2026-04-29' });
  });

  it('rejects start > end', () => {
    expect(() =>
      resolveDateRange({ start: '2026-04-10', end: '2026-04-01' }, TZ, NOW),
    ).toThrow(/INVALID_DATE_RANGE/);
  });

  it('rejects end date in the future (in network tz)', () => {
    expect(() =>
      resolveDateRange({ start: '2026-04-01', end: '2026-05-15' }, TZ, NOW),
    ).toThrow(/INVALID_DATE_RANGE/);
  });
});
