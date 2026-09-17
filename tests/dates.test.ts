import { describe, it, expect } from 'vitest';
import {
  RELATIVE_RANGES,
  isCalendarDate,
  lastDays,
  previousPeriod,
  previousYear,
  rangeRuleFor,
  resolveDateRange,
  type DateRangeInput,
  type RangeRule,
} from '../src/dates.js';

const TZ = 'Asia/Tokyo';
// 2026-09-17 12:00 in Hong Kong: today is the 17th, yesterday the 16th.
const NOW = new Date('2026-09-17T04:00:00Z');

function resolve(range: DateRangeInput, at: string | Date = NOW, rule: RangeRule = 'historical', timezone = TZ) {
  const now = typeof at === 'string' ? new Date(`${at}T04:00:00Z`) : at;
  return resolveDateRange(range, { timezone, now, rule });
}

function reasonOf(r: unknown): string {
  if (!r || typeof r !== 'object' || !('error' in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  const { error } = r as { error: { code: string; details: { reason: string } } };
  expect(error.code).toBe('INVALID_DATE_RANGE');
  return error.details.reason;
}

describe('relative ranges (spec §3.2)', () => {
  it('offers no relative today', () => {
    expect(RELATIVE_RANGES).not.toContain('today');
    expect([...RELATIVE_RANGES].sort()).toEqual([
      'last_30_days', 'last_7_days', 'last_full_month', 'last_quarter', 'last_week',
      'month_to_date', 'quarter_to_date', 'year_to_date', 'yesterday',
    ]);
  });

  it.each([
    ['yesterday', '2026-09-17', { start: '2026-09-16', end: '2026-09-16' }],
    ['last_7_days', '2026-09-17', { start: '2026-09-10', end: '2026-09-16' }],
    ['last_30_days', '2026-09-17', { start: '2026-08-18', end: '2026-09-16' }],
    ['last_week', '2026-09-17', { start: '2026-09-07', end: '2026-09-13' }], // a Thursday
    ['last_week', '2026-09-13', { start: '2026-08-31', end: '2026-09-06' }], // a Sunday
    ['last_week', '2026-09-14', { start: '2026-09-07', end: '2026-09-13' }], // a Monday
    ['last_full_month', '2026-09-17', { start: '2026-08-01', end: '2026-08-31' }],
    ['last_full_month', '2026-01-05', { start: '2025-12-01', end: '2025-12-31' }],
    ['month_to_date', '2026-09-17', { start: '2026-09-01', end: '2026-09-16' }],
    ['month_to_date', '2026-09-02', { start: '2026-09-01', end: '2026-09-01' }],
    ['quarter_to_date', '2026-09-17', { start: '2026-07-01', end: '2026-09-16' }],
    ['last_quarter', '2026-09-17', { start: '2026-04-01', end: '2026-06-30' }],
    ['last_quarter', '2026-02-10', { start: '2025-10-01', end: '2025-12-31' }],
    ['year_to_date', '2026-09-17', { start: '2026-01-01', end: '2026-09-16' }],
  ] as const)('%s on %s', (relative, today, expected) => {
    expect(resolve({ relative }, today)).toEqual(expected);
  });

  it.each([
    ['month_to_date', '2026-09-01'],
    ['quarter_to_date', '2026-07-01'],
    ['year_to_date', '2026-01-01'],
  ] as const)('%s on %s has no complete day yet', (relative, today) => {
    expect(reasonOf(resolve({ relative }, today))).toContain('no complete day in this period yet');
  });

  it('resolves in the date time zone (D6)', () => {
    const now = new Date('2026-09-16T16:30:00Z');
    expect(resolve({ relative: 'yesterday' }, now, 'historical', 'Asia/Seoul')).toEqual({ start: '2026-09-16', end: '2026-09-16' });
    expect(resolve({ relative: 'yesterday' }, now, 'historical', 'UTC')).toEqual({ start: '2026-09-15', end: '2026-09-15' });
  });
});

describe('absolute ranges (spec §3.2)', () => {
  it('passes a checked range through', () => {
    expect(resolve({ start: '2026-09-01', end: '2026-09-16' })).toEqual({ start: '2026-09-01', end: '2026-09-16' });
  });

  it.each(['banana', '2026-02-30', '2026-2-3', '2026-13-01', '', '2026-09-01T00:00:00Z'])(
    'rejects %j as a date, naming the field',
    (bad) => {
      const r = resolveDateRange({ start: bad, end: '2026-09-02' }, { timezone: TZ, now: NOW, rule: 'historical', field: 'base_range' });
      expect(reasonOf(r)).toBe(`base_range: start ${JSON.stringify(bad)} is not a real date in YYYY-MM-DD form`);
      expect((r as { error: { details: { field: string } } }).error.details.field).toBe('base_range');
    },
  );

  it('rejects start after end', () => {
    expect(reasonOf(resolve({ start: '2026-09-10', end: '2026-09-01' }))).toBe('date_range: start 2026-09-10 is after end 2026-09-01');
  });

  it('a historical range must end by yesterday in the date time zone', () => {
    expect(reasonOf(resolve({ start: '2026-09-01', end: '2026-09-17' })))
      .toBe('date_range: end 2026-09-17 is after yesterday (2026-09-16) in Asia/Tokyo');
    // 16:30 UTC on the 16th is already the 17th in Asia/Seoul, not in UTC.
    const now = new Date('2026-09-16T16:30:00Z');
    expect(resolve({ start: '2026-09-16', end: '2026-09-16' }, now, 'historical', 'Asia/Seoul')).toEqual({ start: '2026-09-16', end: '2026-09-16' });
    expect(reasonOf(resolve({ start: '2026-09-16', end: '2026-09-16' }, now, 'historical', 'UTC'))).toContain('after yesterday (2026-09-15) in UTC');
  });

  it('a forecast must start today or later, and must be given as dates', () => {
    expect(resolve({ start: '2026-09-17', end: '2026-12-31' }, NOW, 'forecast')).toEqual({ start: '2026-09-17', end: '2026-12-31' });
    expect(reasonOf(resolve({ start: '2026-09-16', end: '2026-09-30' }, NOW, 'forecast')))
      .toBe('date_range: start 2026-09-16 is before today (2026-09-17) in Asia/Tokyo; a forecast covers today and later');
    expect(reasonOf(resolve({ relative: 'last_7_days' }, NOW, 'forecast'))).toContain('not a relative range');
  });

  it('never throws', () => {
    expect(() => resolve({ start: 'x', end: 'y' })).not.toThrow();
    expect(() => resolve({ relative: 'nope' } as never)).not.toThrow();
  });
});

describe('rangeRuleFor', () => {
  it('treats only FUTURE_SELL_THROUGH as a forecast', () => {
    expect(rangeRuleFor('FUTURE_SELL_THROUGH')).toBe('forecast');
    for (const t of ['HISTORICAL', 'REACH', 'AD_SPEED', 'PRIVACY_AND_MESSAGING', undefined]) {
      expect(rangeRuleFor(t)).toBe('historical');
    }
  });
});

describe('derived ranges', () => {
  it('I4: previous_year clamps to the month and keeps a month-end end', () => {
    expect(previousYear({ start: '2028-02-01', end: '2028-02-29' })).toEqual({ start: '2027-02-01', end: '2027-02-28' });
    expect(previousYear({ start: '2029-02-01', end: '2029-02-28' })).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(previousYear({ start: '2028-02-29', end: '2028-03-15' })).toEqual({ start: '2027-02-28', end: '2027-03-15' });
    expect(previousYear({ start: '2026-09-01', end: '2026-09-16' })).toEqual({ start: '2025-09-01', end: '2025-09-16' });
  });

  it('previous_period keeps the equal-length window', () => {
    expect(previousPeriod({ start: '2026-09-10', end: '2026-09-16' })).toEqual({ start: '2026-09-03', end: '2026-09-09' });
    expect(previousPeriod({ start: '2026-03-01', end: '2026-03-01' })).toEqual({ start: '2026-02-28', end: '2026-02-28' });
  });

  it('lastDays ends yesterday in the date time zone', () => {
    expect(lastDays(1, TZ, NOW)).toEqual({ start: '2026-09-16', end: '2026-09-16' });
    expect(lastDays(14, TZ, NOW)).toEqual({ start: '2026-09-03', end: '2026-09-16' });
  });

  it('isCalendarDate', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2026-04-31')).toBe(false);
  });
});
