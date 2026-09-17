// Shared report helpers for diagnostic tools that need raw rows (rather than
// the inline-or-file envelope buildReportTool produces) so they can
// post-process — funnel attribution, floor-pricing classification, etc.
import type { Cell } from './values.js';
import type { DateRange } from './gam-client.js';

// ponytail: missing values still count as 0 here; 0.6.0 PR 4 replaces this with null-propagating arithmetic.
export function numOr0(v: Cell | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function pct(fraction: number): string {
  return (fraction * 100).toFixed(2);
}

// Last `days` full days ending yesterday, in the network timezone.
export function lookbackRange(days: number, timezone: string, now: Date | undefined): DateRange {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now ?? new Date());
  const [y, m, d] = today.split('-').map(Number);
  const yest = new Date(Date.UTC(y, m - 1, d - 1));
  const start = new Date(yest.getTime() - (days - 1) * 86_400_000);
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(yest) };
}

// The equal-length window immediately preceding `r`.
export function previousPeriod(r: DateRange): DateRange {
  const oneDay = 86_400_000;
  const start = new Date(`${r.start}T00:00:00Z`);
  const end = new Date(`${r.end}T00:00:00Z`);
  const lengthMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - oneDay);
  const prevStart = new Date(prevEnd.getTime() - lengthMs);
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  return { start: iso(prevStart), end: iso(prevEnd) };
}
