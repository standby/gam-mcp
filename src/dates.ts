import { gamError, type GamErrorEnvelope } from './errors.js';

// The relative ranges a caller may ask for (spec §3.2). Every one ends by
// yesterday: there is no `today`, because a day that has not ended has
// incomplete numbers.
export const RELATIVE_RANGES = [
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_week',
  'last_full_month',
  'month_to_date',
  'quarter_to_date',
  'last_quarter',
  'year_to_date',
] as const;

export type RelativeRange = (typeof RELATIVE_RANGES)[number];

// What a tool accepts: dates, or a range relative to today.
export type DateRangeInput = { start: string; end: string } | { relative: RelativeRange };

export type ResolvedRange = { start: string; end: string };

// The checks a range gets beyond start ≤ end (spec §3.2). A historical
// report must end by yesterday. A forecast must start today or later and be
// given as dates, because a past window returns nothing and an empty
// forecast must not read as zero.
export type RangeRule = 'historical' | 'forecast';

export function rangeRuleFor(reportType: string | undefined): RangeRule {
  return reportType === 'FUTURE_SELL_THROUGH' ? 'forecast' : 'historical';
}

export type ResolveOptions = {
  // The date time zone (GAM_TIMEZONE): what "today" is.
  timezone: string;
  now?: Date;
  rule: RangeRule;
  // The input field named in errors.
  field?: string;
};

// Resolves and checks a range in the date time zone. Every failure is an
// INVALID_DATE_RANGE envelope naming the field; nothing is thrown.
export function resolveDateRange(
  range: DateRangeInput,
  opts: ResolveOptions,
): ResolvedRange | GamErrorEnvelope {
  const field = opts.field ?? 'date_range';
  const invalid = (reason: string) => gamError('INVALID_DATE_RANGE', { field, reason: `${field}: ${reason}` });
  const today = todayIn(opts.timezone, opts.now);

  if ('relative' in range) {
    if (opts.rule === 'forecast') {
      return invalid('a forecast takes start and end dates from today on, not a relative range');
    }
    const resolved = relativeRange(range.relative, today);
    return typeof resolved === 'string' ? invalid(resolved) : resolved;
  }

  for (const key of ['start', 'end'] as const) {
    if (!isCalendarDate(range[key])) {
      return invalid(`${key} ${JSON.stringify(range[key])} is not a real date in YYYY-MM-DD form`);
    }
  }
  if (range.start > range.end) return invalid(`start ${range.start} is after end ${range.end}`);
  if (opts.rule === 'historical') {
    const yesterday = addDays(today, -1);
    if (range.end > yesterday) {
      return invalid(`end ${range.end} is after yesterday (${yesterday}) in ${opts.timezone}`);
    }
  } else if (range.start < today) {
    return invalid(`start ${range.start} is before today (${today}) in ${opts.timezone}; a forecast covers today and later`);
  }
  return { start: range.start, end: range.end };
}

// A YYYY-MM-DD string naming a day that exists (2026-02-30 does not).
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// The last `days` complete days, ending yesterday in the date time zone.
export function lastDays(days: number, timezone: string, now?: Date): ResolvedRange {
  const yesterday = addDays(todayIn(timezone, now), -1);
  return { start: addDays(yesterday, -(days - 1)), end: yesterday };
}

// The equal-length window immediately before `r`.
export function previousPeriod(r: ResolvedRange): ResolvedRange {
  const end = addDays(r.start, -1);
  return { start: addDays(end, -daysBetween(r.start, r.end)), end };
}

// `r` one calendar year earlier. A day the earlier month lacks is clamped
// to its last day, and a range that ends on its month's last day still does
// (2028-02-01..2028-02-29 → 2027-02-01..2027-02-28).
export function previousYear(r: ResolvedRange): ResolvedRange {
  return { start: shiftYear(r.start, false), end: shiftYear(r.end, isLastDayOfMonth(r.end)) };
}

function relativeRange(name: RelativeRange, today: string): ResolvedRange | string {
  const yesterday = addDays(today, -1);
  const [y, m] = parts(today);
  // A period-to-date range has no complete day on its first day.
  const toDate = (start: string): ResolvedRange | string =>
    start <= yesterday ? { start, end: yesterday } : `no complete day in this period yet (${name} on ${today})`;
  const quarterStart = m - ((m - 1) % 3);
  switch (name) {
    case 'yesterday':
      return { start: yesterday, end: yesterday };
    case 'last_7_days':
      return lastOf(7, yesterday);
    case 'last_30_days':
      return lastOf(30, yesterday);
    case 'last_week': {
      // Monday to Sunday of the last complete week.
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
      const lastSunday = addDays(today, -(weekday === 0 ? 7 : weekday));
      return { start: addDays(lastSunday, -6), end: lastSunday };
    }
    case 'last_full_month': {
      const end = addDays(ymd(y, m, 1), -1);
      const [py, pm] = parts(end);
      return { start: ymd(py, pm, 1), end };
    }
    case 'month_to_date':
      return toDate(ymd(y, m, 1));
    case 'quarter_to_date':
      return toDate(ymd(y, quarterStart, 1));
    case 'last_quarter': {
      const end = addDays(ymd(y, quarterStart, 1), -1);
      const [py, pm] = parts(end);
      return { start: ymd(py, pm - 2, 1), end };
    }
    case 'year_to_date':
      return toDate(ymd(y, 1, 1));
  }
}

function lastOf(days: number, yesterday: string): ResolvedRange {
  return { start: addDays(yesterday, -(days - 1)), end: yesterday };
}

function todayIn(timezone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD; Intl is Node's only zoned-date path.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isLastDayOfMonth(date: string): boolean {
  const [y, m, d] = parts(date);
  return d === daysInMonth(y, m);
}

function shiftYear(date: string, toMonthEnd: boolean): string {
  const [y, m, d] = parts(date);
  const last = daysInMonth(y - 1, m);
  return ymd(y - 1, m, toMonthEnd ? last : Math.min(d, last));
}

function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}
