import { gamError, type GamErrorEnvelope } from './errors.js';
import { ResultUnavailableError, type DateRange, type ReportQuery, type RowsPage, type StoredReport } from './gam-client.js';
import type { Logger } from './log.js';
import type { ToolContext } from './report-tool-builder.js';
import { reportDefinition, type ReportDefinition } from './report-definition.js';
import { buildTable, type Cell, type Column } from './values.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import { envelope, inferSchema, type DateSpan, type InputReport, type ResultEnvelope } from './envelope.js';

export const GAM_MAX_PAGE_ROWS = 10_000;
export const DEFAULT_PAGE_ROWS = 5_000;
// ponytail: fixed ceiling on rows a computing tool reads; page its output if a real network needs more.
export const MAX_INPUT_ROWS = 50_000;

export type ReportRequest = {
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
    const s = await ctx.client.pollOperation(operation);
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

async function runToResult(
  ctx: ToolContext,
  query: ReportQuery,
  dateRange: DateRange,
): Promise<{ report: string; result: string } | GamErrorEnvelope> {
  ctx.logger.debug('report.create', {
    dimensions: query.dimensions,
    metrics: query.metrics,
    date_start: dateRange.start,
    date_end: dateRange.end,
  });
  const { report } = await ctx.client.defineReport(query, dateRange);
  const { operation } = await ctx.client.runReport(report);
  const done = await pollUntilDone(ctx, operation);
  return 'error' in done ? done : { report, result: done.result };
}

function toGamError(e: unknown): GamErrorEnvelope {
  if (e instanceof ResultUnavailableError) return gamError('REPORT_RESULT_EXPIRED', { result: e.result });
  return gamError('INTERNAL_ERROR', { reason: e instanceof Error ? e.message : String(e) });
}

// A first page with no totalRowCount and no further page has exactly its own
// rows: proto3 JSON omits zero. With a further page the count is unknown.
function firstPageTotal(page: RowsPage): number | null {
  return page.totalRowCount ?? (page.nextPageToken ? null : page.rows.length);
}

// Definition-derived caveats (reach non-additivity, the alias/KV rewrite
// notes, ...) are only computed once, for the first page. A later page has
// no access to them, so rather than silently drop them it points back at
// where they live. PR 2 rebuilds them per page instead of pointing back.
const CAVEATS_ON_FIRST_PAGE =
  'Caveats that apply to this whole report are listed on its first page; read them with these rows.';

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
  const warnings = [...a.warnings, ...table.warnings];
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
      date_time_zone: a.ctx.timezone,
      dimensions: a.definition.dimensions,
      metrics: a.definition.metrics,
      filters: a.definition.filters ?? [],
      sort: [],
      cache: { hit: false },
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
    const ran = await runToResult(ctx, req.query, req.dateRange);
    if ('error' in ran) return ran;
    const page = await ctx.client.fetchRows(ran.result, { pageSize: pageRows(ctx) });
    return pageEnvelope({
      ctx,
      report: ran.report,
      result: ran.result,
      definition: reportDefinition(req.query, req.dateRange),
      summary: req.summary,
      warnings: req.warnings ?? [],
      page,
      offset: 0,
      total: firstPageTotal(page),
      runTime: page.runTime ?? null,
      dateRange: page.dateRanges?.[0] ?? null,
    });
  } catch (e) {
    return toGamError(e);
  }
}

// Stored definitions never change (reports are never patched), so they can be
// remembered per client for the life of the process.
const storedReports = new WeakMap<object, Map<string, StoredReport>>();
const STORED_REPORTS_MAX = 1000;

async function storedReport(ctx: ToolContext, report: string): Promise<StoredReport | null> {
  let byName = storedReports.get(ctx.client);
  if (!byName) storedReports.set(ctx.client, (byName = new Map()));
  const hit = byName.get(report);
  if (hit) return hit;
  const found = await ctx.client.getReport(report);
  if (found) {
    if (byName.size >= STORED_REPORTS_MAX) byName.delete(byName.keys().next().value!);
    byName.set(report, found);
  }
  return found;
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
    const page = await ctx.client.fetchRows(cursor.result, { pageSize: pageRows(ctx), pageToken: cursor.page_token });
    const last = cursor.offset + page.rows.length;
    // A missing count from GAM is only unknowable while more pages remain —
    // on the page that turns out to be the last one, the total is exactly
    // what's been seen so far.
    const total = cursor.total_row_count ?? (page.nextPageToken ? null : last);
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
      runTime: cursor.run_time,
      dateRange: cursor.date_range,
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
): Promise<ReportRows | GamErrorEnvelope> {
  try {
    const ran = await runToResult(ctx, query, dateRange);
    if ('error' in ran) return ran;
    const pages: RowsPage[] = [];
    let token: string | undefined;
    let count = 0;
    do {
      const page = await ctx.client.fetchRows(ran.result, {
        pageSize: GAM_MAX_PAGE_ROWS,
        ...(token && { pageToken: token }),
      });
      if (pages.length === 0 && (page.totalRowCount ?? 0) > MAX_INPUT_ROWS) {
        return tooLarge(page.totalRowCount!, MAX_INPUT_ROWS, 'input report');
      }
      count += page.rows.length;
      if (count > MAX_INPUT_ROWS) return tooLarge(count, MAX_INPUT_ROWS, 'input report');
      pages.push(page);
      token = page.nextPageToken;
    } while (token);
    const table = buildTable(query.dimensions, query.metrics, pages.flatMap((p) => p.rows));
    const warnings = [...table.warnings];
    const reportedTotal = pages[0].totalRowCount;
    if (reportedTotal !== undefined && reportedTotal !== count) {
      warnings.push(
        `GAM reported ${reportedTotal} rows for ${ran.result} but served ${count}; results below were computed from ${count} rows.`,
      );
    }
    return {
      columns: table.columns,
      rows: table.rows,
      warnings,
      input: {
        report: ran.report,
        result: ran.result,
        run_time: pages[0].runTime ?? null,
        date_range: pages[0].dateRanges?.[0] ?? null,
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
    provenance: { network_code: ctx.networkCode, date_time_zone: ctx.timezone, inputs: d.inputs },
    total_row_count: d.rows.length,
    truncated: false,
    next_cursor: null,
    warnings: d.warnings ?? [],
    schema: inferSchema(d.rows),
    rows: d.rows,
  });
}
