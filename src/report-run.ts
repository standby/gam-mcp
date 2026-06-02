// Shared report-execution helpers for diagnostic tools that need raw rows
// (rather than the inline-or-file envelope buildReportTool produces) so they
// can post-process — funnel attribution, floor-pricing classification, etc.
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { readCsvGz } from './output.js';
import type { ToolContext } from './report-tool-builder.js';
import type { ReportQuery, DateRange } from './gam-client.js';

export function numOr0(v: string | undefined): number {
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

// Create → poll → download → parse a report into rows, using the report cache
// when available. Cleans up the temp CSV after reading.
export async function runAndRead(
  ctx: ToolContext,
  query: ReportQuery,
  range: DateRange,
): Promise<Record<string, string>[]> {
  const cached = ctx.reportCache?.get(query, range);
  if (cached) return cached;
  const op = await ctx.client.createReport(query, range);
  const start = Date.now();
  let delay = 2000;
  const timeoutMs = ctx.reportTimeoutMs ?? 300_000;
  while (Date.now() - start < timeoutMs) {
    const s = await ctx.client.pollOperation(op.operation_name);
    if (s.state === 'done') {
      const dest = join(ctx.output.tempDir, `${op.operation_name.replace(/[^\w]/g, '_')}.csv.gz`);
      await ctx.client.downloadReport(s.download_url, dest);
      const { rows } = await readCsvGz(dest);
      try { unlinkSync(dest); } catch { /* ignore */ }
      ctx.reportCache?.set(query, range, rows);
      return rows;
    }
    if (s.state === 'failed') throw new Error(`report failed: ${s.reason}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15_000);
  }
  throw new Error(`report timed out after ${timeoutMs}ms`);
}
