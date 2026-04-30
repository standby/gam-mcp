export type RelativeRange =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_week'
  | 'last_full_month'
  | 'month_to_date'
  | 'quarter_to_date'
  | 'last_quarter'
  | 'year_to_date';

export type DateRange =
  | { start: string; end: string }
  | { relative: RelativeRange };

export type ResolvedRange = { start: string; end: string };

export function resolveDateRange(
  range: DateRange,
  timezone: string,
  now: Date = new Date(),
): ResolvedRange {
  const today = ymdInTz(now, timezone);
  const yesterday = addDays(today, -1);

  if ('start' in range) {
    if (range.start > range.end) {
      throw new Error(`INVALID_DATE_RANGE: start ${range.start} is after end ${range.end}`);
    }
    if (range.end > yesterday) {
      throw new Error(
        `INVALID_DATE_RANGE: end ${range.end} is after yesterday ${yesterday} in ${timezone}`,
      );
    }
    return { start: range.start, end: range.end };
  }

  switch (range.relative) {
    case 'today':       return { start: today, end: today };
    case 'yesterday':   return { start: yesterday, end: yesterday };
    case 'last_7_days': return { start: addDays(yesterday, -6), end: yesterday };
    case 'last_30_days':return { start: addDays(yesterday, -29), end: yesterday };
    case 'last_week': {
      // Mon-Sun of the previous full week
      const dow = dayOfWeekInTz(now, timezone); // 0=Sun..6=Sat
      const daysSinceLastSunday = dow === 0 ? 7 : dow;
      const lastSunday = addDays(today, -daysSinceLastSunday);
      const lastMonday = addDays(lastSunday, -6);
      return { start: lastMonday, end: lastSunday };
    }
    case 'last_full_month': {
      const [y, m] = today.split('-').map(Number);
      const firstOfThisMonth = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = addDays(firstOfThisMonth, -1);
      const [py, pm] = lastDay.split('-').map(Number);
      const firstOfPrev = `${py}-${String(pm).padStart(2, '0')}-01`;
      return { start: firstOfPrev, end: lastDay };
    }
    case 'month_to_date': {
      const [y, m] = today.split('-').map(Number);
      return { start: `${y}-${String(m).padStart(2, '0')}-01`, end: yesterday };
    }
    case 'quarter_to_date': {
      const [y, m] = today.split('-').map(Number);
      const qStartMonth = m - ((m - 1) % 3);
      return {
        start: `${y}-${String(qStartMonth).padStart(2, '0')}-01`,
        end: yesterday,
      };
    }
    case 'last_quarter': {
      const [y, m] = today.split('-').map(Number);
      const thisQStart = m - ((m - 1) % 3);
      let lastQStartMonth = thisQStart - 3;
      let lastQYear = y;
      if (lastQStartMonth <= 0) {
        lastQStartMonth += 12;
        lastQYear -= 1;
      }
      const start = `${lastQYear}-${String(lastQStartMonth).padStart(2, '0')}-01`;
      const lastQEndDay = addDays(`${y}-${String(thisQStart).padStart(2, '0')}-01`, -1);
      return { start, end: lastQEndDay };
    }
    case 'year_to_date': {
      const [y] = today.split('-').map(Number);
      return { start: `${y}-01-01`, end: yesterday };
    }
  }
}

function ymdInTz(d: Date, tz: string): string {
  // Intl is the only stdlib path to a ZonedDateTime in Node.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA outputs YYYY-MM-DD already.
  return fmt.format(d);
}

function dayOfWeekInTz(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const wd = fmt.format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
