// Time zones as the report path needs them (spec §2.4): GAM computes days in
// the network's zone, while GAM_TIMEZONE chooses which calendar dates to ask
// for. The two may differ as long as their UTC offsets agree on every day a
// result covers.

import { Lru } from './lru.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Transitions happen on quarter-hour boundaries in every zone in use.
const STEP = 15 * MINUTE;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Ranges longer than this (about ten years) are not compared day by day.
export const MAX_COMPARED_DAYS = 3_700;
// Comparisons already made: every page of a result asks the same question.
const compared = new Lru<string, boolean>(1_000);

// The canonical IANA name for a zone, or null if this runtime does not know
// it, or if `name` is a raw UTC offset (e.g. "+08:00", "-0500") rather than an
// IANA zone name — Node's Intl accepts offsets as a timeZone value, but the
// documented rule is an IANA name only. Etc/GMT-8 and similar stay accepted:
// they're spelled with a leading letter, so they're IANA names, not offsets.
export function canonicalTimeZone(name: string): string | null {
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
    if (canonical.startsWith('+') || canonical.startsWith('-')) return null;
    return canonical;
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

function spanDays(range: { start: string; end: string }): number {
  return (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / DAY + 1;
}

// Whether two zones have different UTC offsets at any instant that can fall on
// a calendar day of `range` in either of them. Offsets are compared at every
// UTC midnight from the day before `start` to two days after `end`; a day on
// which either zone changes offset is also checked every 15 minutes. A range
// that cannot be read, that ends before it starts, or that is longer than
// MAX_COMPARED_DAYS proves nothing, so it counts as differing. Answers are
// remembered.
export function offsetsDiffer(a: string, b: string, range: { start: string; end: string }): boolean {
  const key = `${a}|${b}|${range.start}|${range.end}`;
  let differ = compared.get(key);
  if (differ === undefined) {
    differ = compareOffsets(a, b, range);
    compared.set(key, differ);
  }
  return differ;
}

function compareOffsets(a: string, b: string, range: { start: string; end: string }): boolean {
  const start = Date.parse(`${range.start}T00:00:00Z`);
  const end = Date.parse(`${range.end}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return true;
  if (spanDays(range) > MAX_COMPARED_DAYS) return true;
  const first = start - DAY;
  const last = end + 2 * DAY;
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
    if (spanDays(range) > MAX_COMPARED_DAYS) {
      return `${head}, and ${range.start}..${range.end} is too long for this server to compare the two zones' UTC offsets on every day.`;
    }
    if (!offsetsDiffer(dateZone, reportZone, range)) return null;
    return `${head}, and the two zones' UTC offsets differ on at least one day of ${range.start}..${range.end}: ` +
      'those days do not cover the same hours as the dates you asked for.';
  }
  return `${head}, and this result does not say which days it covers, so it cannot show that their day boundaries line up.`;
}

// The zone GAM counted a report's days in, from its definition's time zone
// source (spec §2.4), or null when this server cannot name it: a report
// created elsewhere may use the Ad Exchange zone, or not say.
export function reportZoneOf(definition: { timeZoneSource?: string; timeZone?: string }, networkZone: string): string | null {
  switch (definition.timeZoneSource) {
    case 'PUBLISHER':
      return networkZone;
    case 'UTC':
      return 'UTC';
    case 'PROVIDED':
      return definition.timeZone ? canonicalTimeZone(definition.timeZone) : null;
    default:
      return null;
  }
}

// The warning for a result whose report zone this server cannot name.
export function unknownZoneWarning(dateZone: string, source: string | undefined): string {
  return `GAM counted this report's days in a time zone this server cannot name (time zone source ${source ?? 'not stated'}), ` +
    `so they may not cover the same hours as dates chosen in ${dateZone} (GAM_TIMEZONE).`;
}
