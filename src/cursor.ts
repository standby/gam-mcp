import type { DateSpan } from './envelope.js';

// A page cursor carries what GAM returns only on a result's first page. It is
// not signed: it names a result the same service account could produce by
// running the report again, so it grants nothing new (spec §1.3).
export type Cursor = {
  v: 1;
  result: string;
  page_token: string;
  offset: number;
  total_row_count: number | null;
  run_time: string | null;
  date_range: DateSpan | null;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeCursor(c: Omit<Cursor, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...c })).toString('base64url');
}

const isCount = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;

export function decodeCursor(text: string, networkCode: string): Cursor | { error: string } {
  if (!BASE64URL.test(text)) return { error: 'cursor is not base64url text' };
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return { error: 'cursor does not decode to JSON' };
  }
  if (typeof c !== 'object' || c === null || c.v !== 1) return { error: 'cursor version is not 1' };
  const resultPattern = new RegExp(`^networks/${networkCode}/reports/\\d+/results/\\d+$`);
  if (typeof c.result !== 'string' || !resultPattern.test(c.result)) {
    return { error: `cursor does not name a report result in network ${networkCode}` };
  }
  if (typeof c.page_token !== 'string' || c.page_token.length === 0) return { error: 'cursor has no page token' };
  if (!isCount(c.offset)) return { error: 'cursor offset is not a non-negative integer' };
  if (c.total_row_count !== null && !isCount(c.total_row_count)) return { error: 'cursor row count is invalid' };
  if (c.run_time !== null && typeof c.run_time !== 'string') return { error: 'cursor run time is invalid' };
  const dr = c.date_range as DateSpan | null;
  if (dr !== null && (typeof dr?.start !== 'string' || typeof dr?.end !== 'string')) {
    return { error: 'cursor date range is invalid' };
  }
  return c as unknown as Cursor;
}
