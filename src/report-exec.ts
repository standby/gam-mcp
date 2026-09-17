import { CredentialError, gamError, type GamErrorEnvelope } from './errors.js';
import {
  GamHttpError,
  ResultUnavailableError,
  type DateRange,
  type OperationStatus,
  type ReportQuery,
  type RowsPage,
  type StoredReport,
} from './gam-client.js';
import type { Logger } from './log.js';
import type { ToolContext } from './report-tool-builder.js';
import { definitionRange, reportDefinition, type ReportDefinition } from './report-definition.js';
import { buildTable, type Cell, type Column } from './values.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import { envelope, inferSchema, type DateSpan, type InputReport, type ResultEnvelope } from './envelope.js';
import { Lru } from './lru.js';
import { definitionWarnings } from './report-warnings.js';
import { zoneWarning } from './zones.js';
import { definitionHash } from './report-key.js';
import { findOrCreateReport } from './report-reuse.js';
import { names, type DoneEntry, type PendingEntry, type ResultRef } from './cache.js';

export const GAM_MAX_PAGE_ROWS = 10_000;
export const DEFAULT_PAGE_ROWS = 5_000;
// ponytail: fixed ceiling on rows a computing tool reads; page its output if a real network needs more.
export const MAX_INPUT_ROWS = 50_000;
// How many stored definitions and first-page facts each client remembers.
export const REMEMBERED_RESULTS_MAX = 1000;

export type ReportRequest = {
  // The tool asking, named in the report path's logs.
  tool: string;
  query: ReportQuery;
  dateRange: DateRange;
  summary: string;
  warnings?: string[];
};

export type ReportRows = {
  columns: Column[];
  rows: Record<string, Cell>[];
  input: InputReport;
  warnings: string[];
};

export function resolvePageRows(raw: string | undefined, logger: Logger): number | { error: string } {
  if (raw === undefined) return DEFAULT_PAGE_ROWS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return { error: `GAM_PAGE_ROWS must be a positive integer, got ${raw}` };
  if (n > GAM_MAX_PAGE_ROWS) {
    logger.info('config.page_rows_clamped', { requested: n, used: GAM_MAX_PAGE_ROWS });
    return GAM_MAX_PAGE_ROWS;
  }
  return n;
}

export function pageRows(ctx: ToolContext): number {
  return Math.min(ctx.pageRows ?? DEFAULT_PAGE_ROWS, GAM_MAX_PAGE_ROWS);
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The only polling loop in the server.
export async function pollUntilDone(
  ctx: ToolContext,
  operation: string,
): Promise<{ result: string } | GamErrorEnvelope> {
  const timeoutMs = ctx.reportTimeoutMs ?? 300_000;
  const sleep = ctx.sleep ?? realSleep;
  const start = Date.now();
  let delay = 2000;
  for (;;) {
    let s: OperationStatus;
    try {
      s = await ctx.client.pollOperation(operation);
    } catch (e) {
      return pollFailure(ctx, operation, e);
    }
    const elapsed_ms = Date.now() - start;
    ctx.logger.debug('report.poll', { operation, state: s.state, elapsed_ms });
    if (s.state === 'done') {
      ctx.logger.info('report.done', { operation, total_elapsed_ms: elapsed_ms });
      return { result: s.result };
    }
    if (s.state === 'failed') {
      ctx.logger.warn('report.failed', { operation, reason: s.reason });
      return gamError('REPORT_FAILED', { reason: s.reason, operation });
    }
    if (elapsed_ms + delay > timeoutMs) {
      ctx.logger.error('report.timeout', { operation, timeout_ms: timeoutMs });
      return gamError('REPORT_TIMEOUT', { timeout_ms: timeoutMs, operation });
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15_000);
  }
}

// A poll that threw. The error names the operation, which GAM may still be
// running, so the run can be resumed rather than repeated (spec §2.6).
function pollFailure(ctx: ToolContext, operation: string, e: unknown): GamErrorEnvelope {
  if (e instanceof GamHttpError && e.status === 404) {
    ctx.logger.warn('report.operation_gone', { operation });
    return gamError('REPORT_FAILED', { reason: `GAM no longer knows operation ${operation}`, operation });
  }
  const err = toGamError(e, { operation });
  ctx.logger.warn('report.poll_failed', { operation, error_code: err.error.code });
  return err;
}

// The result that answers a definition, and the cache entry it came from.
// `resumed` is true when this came from waiting on a run a timed-out (or
// otherwise interrupted) call left behind: like a cached result, its result
// may already be gone by the time it's fetched, so firstPage retries once
// rather than treating that as a hard failure. `operation` is the run that
// produced the result, when this process waited on it.
type Obtained = { report: string; result: string; operation?: string; cached: DoneEntry | null; resumed: boolean };

// Finds or creates the report for `key` and runs it, or resumes the run a
// timed-out call left behind, then waits. A wait that ends because GAM says
// the run failed forgets the key; any other ending leaves a pending entry,
// because GAM may still be running the report.
async function runOnce(
  ctx: ToolContext,
  definition: ReportDefinition,
  key: string,
  tool: string,
  pending: PendingEntry | undefined,
): Promise<Obtained | GamErrorEnvelope> {
  let report: string;
  let operation: string;
  if (pending) {
    report = pending.report;
    operation = pending.operation;
    ctx.logger.info('report.resume', { tool, report, operation, started_at: pending.started_at });
  } else {
    report = await findOrCreateReport(ctx, definition, key, tool);
    operation = (await ctx.client.runReport(report)).operation;
  }
  const done = await pollUntilDone(ctx, operation);
  if (!('error' in done)) return { report, result: done.result, operation, cached: null, resumed: pending !== undefined };
  if (done.error.code === 'REPORT_FAILED') {
    ctx.reportCache?.delete(key);
  } else {
    ctx.reportCache?.putPending(key, { report, operation, ...(pending && { started_at: pending.started_at }) });
  }
  return done;
}

// A run in flight, and — only for the caller that started or resumed it —
// how to release it once that caller is done acting on the outcome. A
// joiner (the flight already existed) gets no `release`: only the caller
// that registered the flight retires it, and only once it has finished with
// the result (recorded `done`, decided to retry, or given up) rather than
// merely once the run itself settles — otherwise an identical call arriving
// in that window would start a second run instead of joining (spec §2.6).
type ObtainedRun = {
  promise: Promise<Obtained | GamErrorEnvelope>;
  release?: () => void;
};

// A result GAM no longer serves, and the promise it came from.
type Stale = { promise: Promise<Obtained | GamErrorEnvelope>; ref: ResultRef };

// Spec §2.1 steps 3–6: join an identical run in flight, else use a live
// cached result, else resume a timed-out run, else start one. On the retry
// after a gone result (`stale`), the flight that produced it is retired rather
// than joined, and a cache entry that still names it is passed over; anything
// another call has put in their place since is used as usual.
function obtainResult(
  ctx: ToolContext,
  definition: ReportDefinition,
  key: string,
  tool: string,
  stale: Stale | undefined,
): ObtainedRun {
  const { flights } = clientMemory(ctx);
  const joined = flights.get(key);
  if (joined && joined === stale?.promise) {
    flights.delete(key);
  } else if (joined) {
    ctx.logger.info('report.shared', { tool, key: key.slice(0, 16) });
    return { promise: joined };
  }
  const found = ctx.reportCache?.get(key);
  const entry = found && stale && names(found, stale.ref) ? undefined : found;
  if (entry?.kind === 'done') {
    ctx.logger.info('report.cache_hit', { tool, key: key.slice(0, 16), result: entry.result, run_time: entry.run_time });
    return { promise: Promise.resolve({ report: entry.report, result: entry.result, cached: entry, resumed: false }) };
  }
  const run = runOnce(ctx, definition, key, tool, entry?.kind === 'pending' ? entry : undefined);
  flights.set(key, run);
  return {
    promise: run,
    release: () => {
      if (flights.get(key) === run) flights.delete(key);
    },
  };
}

function toGamError(e: unknown, extra: Record<string, unknown> = {}): GamErrorEnvelope {
  if (e instanceof ResultUnavailableError) return gamError('REPORT_RESULT_EXPIRED', { result: e.result, ...extra });
  if (e instanceof CredentialError) return gamError('AUTH_FAILED', { reason: e.message, ...extra });
  if (e instanceof GamHttpError && e.status === 429) return gamError('QUOTA_EXCEEDED', { call: e.call, ...extra });
  if (e instanceof GamHttpError && (e.status === 401 || e.status === 403)) {
    return gamError('AUTH_FAILED', { call: e.call, status: e.status, gam_status: e.gamStatus ?? null, ...extra });
  }
  return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e), ...extra });
}

// What a result's first page says about the whole result. GAM sends these on
// the first page only.
type ResultFacts = {
  run_time: string | null;
  date_range: DateSpan | null;
  total_row_count: number | null;
};

// A first page with no totalRowCount and no further page has exactly its own
// rows: proto3 JSON omits zero. With a further page the count is unknown.
function firstPageTotal(page: RowsPage): number | null {
  return page.totalRowCount ?? (page.nextPageToken ? null : page.rows.length);
}

function factsOf(page: RowsPage): ResultFacts {
  return {
    run_time: page.runTime ?? null,
    date_range: page.dateRanges?.[0] ?? null,
    total_row_count: firstPageTotal(page),
  };
}

type FirstPage = {
  report: string;
  result: string;
  page: RowsPage;
  facts: ResultFacts;
  // True when an earlier call produced the result (spec §1.1).
  cacheHit: boolean;
};

// The one step both report functions share: obtain the result that answers a
// definition, and read its first page. Report reuse, shared runs, the result
// cache and the re-run of an expired cached result all live here (spec §2.1).
async function firstPage(
  ctx: ToolContext,
  definition: ReportDefinition,
  pageSize: number,
  tool: string,
): Promise<FirstPage | GamErrorEnvelope> {
  // One function names the report and keys the cache (spec §2.2, test E7).
  const key = definitionHash(definition);
  let stale: Stale | undefined;
  for (;;) {
    const obtained = obtainResult(ctx, definition, key, tool, stale);
    // The flight (if this call is its leader) stays registered through this
    // whole attempt — including the fetch and the `done` record below — so a
    // call arriving before that finishes still joins instead of starting a
    // second run (spec §2.6).
    try {
      const got = await obtained.promise;
      if ('error' in got) return got;
      let page: RowsPage;
      try {
        page = await ctx.client.fetchRows(got.result, { pageSize });
      } catch (e) {
        // A cached or resumed result GAM no longer serves is dropped (unless
        // another call has already replaced it) and the report is obtained
        // once more. A result from a fresh run, or from that second attempt,
        // that is already gone is an error.
        if (e instanceof ResultUnavailableError && (got.cached || got.resumed) && !stale) {
          ctx.logger.info('report.cached_result_gone', { tool, result: got.result });
          const ref: ResultRef = { result: got.result, operation: got.operation };
          ctx.reportCache?.delete(key, ref);
          stale = { promise: obtained.promise, ref };
          continue;
        }
        throw e;
      }
      // A hit keeps the facts of the call that produced the result.
      const facts: ResultFacts = got.cached
        ? { run_time: got.cached.run_time, date_range: got.cached.date_range, total_row_count: got.cached.total_row_count }
        : factsOf(page);
      if (!got.cached) ctx.reportCache?.putDone(key, { report: got.report, result: got.result, ...facts });
      clientMemory(ctx).facts.set(got.result, facts);
      return { report: got.report, result: got.result, page, facts, cacheHit: got.cached !== null };
    } finally {
      obtained.release?.();
    }
  }
}

const unique = (items: string[]): string[] => [...new Set(items)];

// Caveats a stored definition implies are rebuilt on every page
// (definitionWarnings). Those that came from the request, such as a renamed
// dimension or a rewritten key-value filter, exist only on the first page, so
// later pages point back to it.
const CAVEATS_ON_FIRST_PAGE =
  "Some caveats, such as renamed dimensions or rewritten key-value filters, are listed only on this report's first page; read them with these rows.";

type PageArgs = {
  ctx: ToolContext;
  report: string;
  result: string;
  definition: ReportDefinition;
  summary: string;
  warnings: string[];
  page: RowsPage;
  offset: number;
  total: number | null;
  runTime: string | null;
  dateRange: DateSpan | null;
  cacheHit: boolean;
};

function pageEnvelope(a: PageArgs): ResultEnvelope {
  const table = buildTable(a.definition.dimensions, a.definition.metrics, a.page.rows);
  const returned = table.rows.length;
  const nextCursor = a.page.nextPageToken
    ? encodeCursor({
        result: a.result,
        page_token: a.page.nextPageToken,
        offset: a.offset + returned,
        total_row_count: a.total,
        run_time: a.runTime,
        date_range: a.dateRange,
      })
    : null;
  const warnings = unique([...a.warnings, ...definitionWarnings(a.definition), ...table.warnings]);
  const zone = zoneWarning(a.ctx.timezone, a.ctx.reportTimeZone, definitionRange(a.definition) ?? a.dateRange);
  if (zone) warnings.push(zone);
  if (a.dateRange === null) warnings.push('GAM did not report the computed date range for this result.');
  if (a.total === null) {
    warnings.push('GAM did not report how many rows this result has.');
  } else if (!nextCursor && a.offset + returned < a.total) {
    warnings.push(`GAM reported ${a.total} rows but returned ${a.offset + returned} and no further page.`);
  }
  return envelope({
    summary: a.summary,
    provenance: {
      network_code: a.ctx.networkCode,
      report_type: a.definition.reportType,
      report: a.report,
      result: a.result,
      run_time: a.runTime,
      date_range: a.dateRange,
      report_time_zone: a.ctx.reportTimeZone,
      date_time_zone: a.ctx.timezone,
      currency_code: a.definition.currencyCode ?? null,
      dimensions: a.definition.dimensions,
      metrics: a.definition.metrics,
      filters: a.definition.filters ?? [],
      sort: a.definition.sorts ?? [],
      cache: { hit: a.cacheHit },
    },
    total_row_count: a.total,
    truncated: nextCursor !== null || (a.total !== null && a.offset + returned < a.total),
    next_cursor: nextCursor,
    warnings,
    schema: table.columns,
    rows: table.rows,
  });
}

export async function executeReport(
  ctx: ToolContext,
  req: ReportRequest,
): Promise<ResultEnvelope | GamErrorEnvelope> {
  try {
    const definition = reportDefinition(req.query, req.dateRange, ctx);
    const first = await firstPage(ctx, definition, pageRows(ctx), req.tool);
    if ('error' in first) return first;
    return pageEnvelope({
      ctx,
      report: first.report,
      result: first.result,
      definition,
      summary: req.summary,
      warnings: req.warnings ?? [],
      page: first.page,
      offset: 0,
      total: first.facts.total_row_count,
      runTime: first.facts.run_time,
      dateRange: first.facts.date_range,
      cacheHit: first.cacheHit,
    });
  } catch (e) {
    return toGamError(e);
  }
}

// What this process remembers per client (the server builds one client per
// process): stored definitions, which never change because reports are never
// patched, and each result's first-page facts, which later pages report
// instead of trusting a cursor.
type ClientMemory = {
  stored: Lru<string, StoredReport>;
  facts: Lru<string, ResultFacts>;
  // Identical runs in flight, by definition hash (spec §2.6).
  flights: Map<string, Promise<Obtained | GamErrorEnvelope>>;
};

const memories = new WeakMap<object, ClientMemory>();

function clientMemory(ctx: ToolContext): ClientMemory {
  let memory = memories.get(ctx.client);
  if (!memory) {
    memory = {
      stored: new Lru(REMEMBERED_RESULTS_MAX),
      facts: new Lru(REMEMBERED_RESULTS_MAX),
      flights: new Map(),
    };
    memories.set(ctx.client, memory);
  }
  return memory;
}

async function storedReport(ctx: ToolContext, report: string): Promise<StoredReport | null> {
  const { stored } = clientMemory(ctx);
  const known = stored.get(report);
  if (known) return known;
  const found = await ctx.client.getReport(report);
  if (found) stored.set(report, found);
  return found;
}

// A result's first-page facts: those of the first page this process served,
// or GAM's own, read again with a one-row page. A cursor's copies are never
// used, because a cursor is not signed.
async function resultFacts(ctx: ToolContext, result: string): Promise<ResultFacts> {
  const { facts } = clientMemory(ctx);
  const known = facts.get(result);
  if (known) return known;
  const fresh = factsOf(await ctx.client.fetchRows(result, { pageSize: 1 }));
  facts.set(result, fresh);
  return fresh;
}

export async function fetchReportPage(
  ctx: ToolContext,
  cursorText: string,
): Promise<ResultEnvelope | GamErrorEnvelope> {
  const cursor = decodeCursor(cursorText, ctx.networkCode);
  if ('error' in cursor) {
    return gamError('INVALID_INPUT', {
      reason: cursor.error,
      hint: 'Pass next_cursor exactly as a previous result returned it.',
    });
  }
  const report = cursor.result.slice(0, cursor.result.indexOf('/results/'));
  try {
    const stored = await storedReport(ctx, report);
    if (!stored) return gamError('REPORT_RESULT_EXPIRED', { result: cursor.result });
    const facts = await resultFacts(ctx, cursor.result);
    const page = await ctx.client.fetchRows(cursor.result, { pageSize: pageRows(ctx), pageToken: cursor.page_token });
    const last = cursor.offset + page.rows.length;
    // A result whose first page gave no count has one once its last page is seen.
    const total = facts.total_row_count ?? (page.nextPageToken ? null : last);
    return pageEnvelope({
      ctx,
      report,
      result: cursor.result,
      definition: stored.definition,
      summary: `Rows ${cursor.offset + 1}–${last} of ${total ?? 'an unreported number'} from ${report}`,
      warnings: [CAVEATS_ON_FIRST_PAGE],
      page,
      offset: cursor.offset,
      total,
      runTime: facts.run_time,
      dateRange: facts.date_range,
      cacheHit: false,
    });
  } catch (e) {
    return toGamError(e);
  }
}

function tooLarge(rows: number, limit: number, what: string): GamErrorEnvelope {
  return gamError('RESULT_TOO_LARGE', { rows, limit, what });
}

export async function executeReportRows(
  ctx: ToolContext,
  query: ReportQuery,
  dateRange: DateRange,
  tool: string,
): Promise<ReportRows | GamErrorEnvelope> {
  try {
    const definition = reportDefinition(query, dateRange, ctx);
    const first = await firstPage(ctx, definition, GAM_MAX_PAGE_ROWS, tool);
    if ('error' in first) return first;
    const reported = first.facts.total_row_count;
    if (reported !== null && reported > MAX_INPUT_ROWS) return tooLarge(reported, MAX_INPUT_ROWS, 'input report');
    const pages: RowsPage[] = [first.page];
    let count = first.page.rows.length;
    let token = first.page.nextPageToken;
    while (token) {
      const page = await ctx.client.fetchRows(first.result, { pageSize: GAM_MAX_PAGE_ROWS, pageToken: token });
      count += page.rows.length;
      if (count > MAX_INPUT_ROWS) return tooLarge(count, MAX_INPUT_ROWS, 'input report');
      pages.push(page);
      token = page.nextPageToken;
    }
    const table = buildTable(definition.dimensions, definition.metrics, pages.flatMap((p) => p.rows));
    const warnings = unique([...definitionWarnings(definition), ...table.warnings]);
    const reportedTotal = first.page.totalRowCount;
    if (reportedTotal !== undefined && reportedTotal !== count) {
      warnings.push(
        `GAM reported ${reportedTotal} rows for ${first.result} but served ${count}; results below were computed from ${count} rows.`,
      );
    }
    const zone = zoneWarning(ctx.timezone, ctx.reportTimeZone, dateRange);
    if (zone) warnings.push(zone);
    return {
      columns: table.columns,
      rows: table.rows,
      warnings,
      input: {
        report: first.report,
        result: first.result,
        run_time: first.facts.run_time,
        date_range: first.facts.date_range,
      },
    };
  } catch (e) {
    return toGamError(e);
  }
}

export function derivedEnvelope(
  ctx: ToolContext,
  d: { summary: string; inputs: InputReport[]; rows: Record<string, unknown>[]; warnings?: string[] },
): ResultEnvelope | GamErrorEnvelope {
  const limit = pageRows(ctx);
  if (d.rows.length > limit) return tooLarge(d.rows.length, limit, 'output');
  return envelope({
    summary: d.summary,
    provenance: {
      network_code: ctx.networkCode,
      report_time_zone: ctx.reportTimeZone,
      date_time_zone: ctx.timezone,
      currency_code: ctx.currencyCode,
      inputs: d.inputs,
    },
    total_row_count: d.rows.length,
    truncated: false,
    next_cursor: null,
    warnings: d.warnings ?? [],
    schema: inferSchema(d.rows),
    rows: d.rows,
  });
}
