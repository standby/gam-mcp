// Time zones as the report path needs them (spec §2.4): GAM computes days in
// the network's zone, while GAM_TIMEZONE chooses which calendar dates to ask
// for. The two may differ as long as their UTC offsets agree on every day a
// result covers.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Transitions happen on quarter-hour boundaries in every zone in use.
const STEP = 15 * MINUTE;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The canonical IANA name for a zone, or null if this runtime does not know it.
export function canonicalTimeZone(name: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    formatters.set(zone, f);
  }
  return f;
}

// Minutes east of UTC at an instant. Intl writes the offset as "GMT",
// "GMT+08:00" or "GMT-04:30".
export function offsetMinutes(zone: string, at: number): number {
  const name = formatter(zone).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!m) throw new Error(`cannot read the UTC offset of ${zone} from ${JSON.stringify(name)}`);
  if (!m[1]) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

// Whether two zones have different UTC offsets at any instant that can fall on
// a calendar day of `range` in either of them. Offsets are compared at every
// UTC midnight from the day before `start` to two days after `end`; a day on
// which either zone changes offset is also checked every 15 minutes. A range
// that cannot be read proves nothing, so it counts as differing.
export function offsetsDiffer(a: string, b: string, range: { start: string; end: string }): boolean {
  const first = Date.parse(`${range.start}T00:00:00Z`) - DAY;
  const last = Date.parse(`${range.end}T00:00:00Z`) + 2 * DAY;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return true;
  for (let day = first; day < last; day += DAY) {
    const a0 = offsetMinutes(a, day);
    const b0 = offsetMinutes(b, day);
    if (a0 !== b0) return true;
    if (offsetMinutes(a, day + DAY) === a0 && offsetMinutes(b, day + DAY) === b0) continue;
    for (let t = day + STEP; t < day + DAY; t += STEP) {
      if (offsetMinutes(a, t) !== offsetMinutes(b, t)) return true;
    }
  }
  return false;
}

function readable(range: { start: string; end: string }): boolean {
  return ISO_DATE.test(range.start) && ISO_DATE.test(range.end) && range.start <= range.end;
}

// The warning a result carries when its dates were chosen in one zone and
// counted by GAM in another whose offsets differ (spec §2.4), or null.
export function zoneWarning(
  dateZone: string,
  reportZone: string,
  range: { start: string; end: string } | null,
): string | null {
  if (dateZone === reportZone) return null;
  const head = `Dates were chosen in ${dateZone} (GAM_TIMEZONE), but GAM counts each day in the network's time zone, ${reportZone}`;
  if (range && readable(range)) {
    if (!offsetsDiffer(dateZone, reportZone, range)) return null;
    return `${head}, and the two zones' UTC offsets differ on at least one day of ${range.start}..${range.end}: ` +
      'those days do not cover the same hours as the dates you asked for.';
  }
  return `${head}, and this result does not say which days it covers, so it cannot show that their day boundaries line up.`;
}
