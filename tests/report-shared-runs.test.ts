import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeReport } from '../src/report-exec.js';
import { createReportCache, PENDING_TTL_MS } from '../src/cache.js';
import { definitionHash } from '../src/report-key.js';
import { createLogger } from '../src/log.js';
import { createFakeGam, int } from './fake-gam.js';
import { counted, definitionFor, NETWORK, ok, restCtx } from './helpers.js';
import type { ToolContext } from '../src/report-tool-builder.js';

const RANGE = { start: '2026-09-01', end: '2026-09-02' };
const query = { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] };
const request = { tool: 'test', query, dateRange: RANGE, summary: 'S' };
const rows = [{ AD_UNIT_ID: 1, IMPRESSIONS: 5 }];
const KEY = definitionHash(definitionFor(query, RANGE));
const operation = (run: number) => `networks/${NETWORK}/operations/reports/runs/${run}`;
const result = (run: number) => `networks/${NETWORK}/reports/1/results/${run}`;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

// Holds the client's `n`th fetchRows call until the returned gate opens.
function holdFetch(ctx: ToolContext, n: number) {
  const held = gate();
  const inner = ctx.client;
  let calls = 0;
  ctx.client = {
    ...inner,
    fetchRows: async (r, p) => {
      calls += 1;
      if (calls === n) await held.opened;
      return inner.fetchRows(r, p);
    },
  };
  return held;
}

describe('shared runs (spec §2.6)', () => {
  it('F1: two concurrent identical calls share one create, run and poll sequence', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'info', sink: (l) => { lines.push(JSON.parse(l)); } });
    const { ctx, counters } = counted({ reports: [{ query, rows }] }, { reportCache: createReportCache({ networkCode: NETWORK }), logger });
    const [a, b] = await Promise.all([
      executeReport(ctx, request),
      executeReport(ctx, { ...request, tool: 'second_tool' }),
    ]);
    expect(ok(a).provenance.result).toBe(result(1));
    expect(ok(b).provenance.result).toBe(result(1));
    expect(ok(b).rows).toEqual(ok(a).rows);
    expect(counters).toMatchObject({ report_definitions_created: 1, report_jobs_created: 1, poll_operations: 2 });
    expect(lines.filter((e) => e.msg === 'report.shared')).toEqual([expect.objectContaining({ tool: 'second_tool' })]);
  });

  it('F1: concurrent identical calls share a run without a result cache too', async () => {
    const { ctx, counters } = counted({ reports: [{ query, rows }] });
    await Promise.all([executeReport(ctx, request), executeReport(ctx, request), executeReport(ctx, request)]);
    expect(counters).toMatchObject({ report_definitions_created: 1, report_jobs_created: 1 });
  });

  it('F2: two concurrent different calls run twice', async () => {
    const { ctx, counters } = counted({ reports: [{ query, rows }] }, { reportCache: createReportCache({ networkCode: NETWORK }) });
    const other = { ...request, dateRange: { start: '2026-09-03', end: '2026-09-04' } };
    const [a, b] = await Promise.all([executeReport(ctx, request), executeReport(ctx, other)]);
    expect(ok(a).provenance.report).not.toBe(ok(b).provenance.report);
    expect(counters).toMatchObject({ report_definitions_created: 2, report_jobs_created: 2 });
  });

  it('F3: a failed shared run fails both callers, and the next call starts fresh', async () => {
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: { 1: 'failed' } },
      { reportCache: createReportCache({ networkCode: NETWORK }) },
    );
    const [a, b] = await Promise.all([executeReport(ctx, request), executeReport(ctx, request)]);
    expect(a).toMatchObject({ error: { code: 'REPORT_FAILED' } });
    expect(b).toEqual(a);
    expect(counters.report_jobs_created).toBe(1);
    expect(ok(await executeReport(ctx, request)).provenance.result).toBe(result(2));
    expect(counters.report_jobs_created).toBe(2);
  });

  it('a call arriving after the run settles but before the first page is recorded still joins it', async () => {
    const { ctx, counters } = counted({ reports: [{ query, rows }] }, { reportCache: createReportCache({ networkCode: NETWORK }) });
    const inner = ctx.client;
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let signalEntered!: () => void;
    const enteredFetch = new Promise<void>((resolve) => { signalEntered = resolve; });
    let fetchCalls = 0;
    ctx.client = {
      ...inner,
      fetchRows: async (r, p) => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          // The run has settled (obtainResult's promise resolved) by the
          // time this fires; the flight must still be registered so the
          // second call below joins it instead of starting a new run.
          signalEntered();
          await gate;
        }
        return inner.fetchRows(r, p);
      },
    };
    const first = executeReport(ctx, request);
    await enteredFetch;
    const second = executeReport(ctx, { ...request, tool: 'second_tool' });
    releaseFetch();
    const [a, b] = await Promise.all([first, second]);
    expect(ok(a).provenance.result).toBe(result(1));
    expect(ok(b).provenance.result).toBe(result(1));
    expect(counters.report_jobs_created).toBe(1);
  });

  it('two different clients running the same definition at once do not share a flight', async () => {
    const a = counted({ reports: [{ query, rows }] });
    const b = counted({ reports: [{ query, rows }] });
    const [ra, rb] = await Promise.all([executeReport(a.ctx, request), executeReport(b.ctx, request)]);
    expect(ok(ra).provenance.result).toBe(result(1));
    expect(ok(rb).provenance.result).toBe(result(1));
    expect(a.counters.report_jobs_created).toBe(1);
    expect(b.counters.report_jobs_created).toBe(1);
  });

  it('two concurrent callers waiting on a run whose runReport throws both get the same error, and the next call starts fresh', async () => {
    const { ctx, counters } = counted({ reports: [{ query, rows }] });
    const inner = ctx.client;
    let fail = true;
    ctx.client = {
      ...inner,
      runReport: async (report) => {
        if (fail) throw new Error('boom');
        return inner.runReport(report);
      },
    };
    const [a, b] = await Promise.all([
      executeReport(ctx, request),
      executeReport(ctx, { ...request, tool: 'second_tool' }),
    ]);
    expect(a).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(b).toEqual(a);
    fail = false;
    expect(ok(await executeReport(ctx, request)).provenance.result).toBe(result(1));
    expect(counters.report_jobs_created).toBe(1);
  });

  it('a caller that finds a cached result gone after another caller ran the report again uses the fresh result', async () => {
    const expired: string[] = [];
    const cache = createReportCache({ networkCode: NETWORK });
    const { ctx, counters } = counted({ reports: [{ query, rows }], expiredResults: expired }, { reportCache: cache });
    ok(await executeReport(ctx, request));
    expired.push(result(1));
    // Both calls hit result 1; the second one's fetch is held until the first
    // has run the report again and recorded result 2.
    const second = holdFetch(ctx, 2);
    const a = executeReport(ctx, request);
    const b = executeReport(ctx, { ...request, tool: 'second_tool' });
    expect(ok(await a).provenance).toMatchObject({ result: result(2), cache: { hit: false } });
    expect(cache.get(KEY)).toMatchObject({ kind: 'done', result: result(2) });
    second.open();
    expect(ok(await b).provenance).toMatchObject({ result: result(2), cache: { hit: true } });
    expect(counters.report_jobs_created).toBe(2);
    expect(cache.get(KEY)).toMatchObject({ kind: 'done', result: result(2) });
  });

  it('a caller that finds a resumed result gone does not wait on that run again', async () => {
    const outcomes: Record<number, 'failed' | 'never'> = { 1: 'never' };
    const expired: string[] = [];
    const cache = createReportCache({ networkCode: NETWORK });
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: outcomes, expiredResults: expired },
      { reportCache: cache, reportTimeoutMs: 0 },
    );
    expect(await executeReport(ctx, request)).toMatchObject({ error: { code: 'REPORT_TIMEOUT' } });
    delete outcomes[1];
    expired.push(result(1));
    // Both calls wait on the resumed run 1. The leader's fetch is held, so the
    // joiner finds result 1 gone while that run is still registered.
    const leader = holdFetch(ctx, 1);
    const later = { ...ctx, reportTimeoutMs: 60_000 };
    const a = executeReport(later, request);
    const b = executeReport(later, { ...request, tool: 'second_tool' });
    expect(ok(await b).provenance).toMatchObject({ result: result(2), cache: { hit: false } });
    leader.open();
    expect(ok(await a).provenance).toMatchObject({ result: result(2), cache: { hit: true } });
    expect(counters.report_jobs_created).toBe(2);
    expect(cache.get(KEY)).toMatchObject({ kind: 'done', result: result(2) });
  });
});

describe('runs that outlive their caller (spec §2.6)', () => {
  it('F4: after REPORT_TIMEOUT the next identical call waits for the same operation', async () => {
    const outcomes: Record<number, 'failed' | 'never'> = { 1: 'never' };
    const cache = createReportCache({ networkCode: NETWORK });
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'info', sink: (l) => { lines.push(JSON.parse(l)); } });
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: outcomes },
      { reportCache: cache, reportTimeoutMs: 0, logger },
    );
    expect(await executeReport(ctx, request)).toMatchObject({
      error: { code: 'REPORT_TIMEOUT', details: { operation: operation(1) } },
    });
    expect(cache.get(KEY)).toMatchObject({ kind: 'pending', report: `networks/${NETWORK}/reports/1`, operation: operation(1) });
    delete outcomes[1]; // GAM finishes the run
    const later = ok(await executeReport({ ...ctx, reportTimeoutMs: 60_000 }, request));
    expect(later.provenance).toMatchObject({ result: result(1), cache: { hit: false } });
    expect(counters.report_jobs_created).toBe(1);
    expect(cache.get(KEY)?.kind).toBe('done');
    expect(lines.filter((e) => e.msg === 'report.resume')).toEqual([
      expect.objectContaining({ tool: 'test', report: `networks/${NETWORK}/reports/1`, operation: operation(1) }),
    ]);
  });

  it('F4: a run that times out again keeps its first start time', async () => {
    let t = Date.parse('2026-09-17T04:00:00Z');
    const cache = createReportCache({ networkCode: NETWORK, now: () => t });
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: { 1: 'never' } },
      { reportCache: cache, reportTimeoutMs: 0 },
    );
    await executeReport(ctx, request);
    t += 10 * 60_000;
    expect(await executeReport(ctx, request)).toMatchObject({
      error: { code: 'REPORT_TIMEOUT', details: { operation: operation(1) } },
    });
    expect(counters.report_jobs_created).toBe(1);
    expect(cache.get(KEY)).toMatchObject({ kind: 'pending', started_at: '2026-09-17T04:00:00.000Z' });
  });

  it('F4: a pending run older than an hour is abandoned for a new one', async () => {
    let t = Date.parse('2026-09-17T04:00:00Z');
    const outcomes: Record<number, 'failed' | 'never'> = { 1: 'never' };
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: outcomes },
      { reportCache: createReportCache({ networkCode: NETWORK, now: () => t }), reportTimeoutMs: 0 },
    );
    await executeReport(ctx, request);
    t += PENDING_TTL_MS;
    // If the pending entry were wrongly treated as still live, the next call
    // would resume operation 1: make that fail fast instead of hanging
    // forever polling an operation that never finishes.
    outcomes[1] = 'failed';
    const later = ok(await executeReport({ ...ctx, reportTimeoutMs: 60_000 }, request));
    expect(later.provenance.result).toBe(result(2));
    expect(counters.report_jobs_created).toBe(2);
  });

  it('forgets a resumed run that GAM reports failed', async () => {
    const outcomes: Record<number, 'failed' | 'never'> = { 1: 'never' };
    const cache = createReportCache({ networkCode: NETWORK });
    const { ctx } = counted({ reports: [{ query, rows }], runOutcomes: outcomes }, { reportCache: cache, reportTimeoutMs: 0 });
    await executeReport(ctx, request);
    outcomes[1] = 'failed';
    expect(await executeReport(ctx, request)).toMatchObject({ error: { code: 'REPORT_FAILED' } });
    expect(cache.get(KEY)).toBeUndefined();
  });

  it('a resumed run whose result is gone runs again once, leaving no stale pending entry', async () => {
    const outcomes: Record<number, 'failed' | 'never'> = { 1: 'never' };
    const expired: string[] = [];
    const cache = createReportCache({ networkCode: NETWORK });
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'info', sink: (l) => { lines.push(JSON.parse(l)); } });
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: outcomes, expiredResults: expired },
      { reportCache: cache, reportTimeoutMs: 0, logger },
    );
    expect(await executeReport(ctx, request)).toMatchObject({ error: { code: 'REPORT_TIMEOUT' } });
    delete outcomes[1]; // GAM finishes the run
    expired.push(result(1)); // ...but its result is gone by the time it's fetched
    const later = ok(await executeReport({ ...ctx, reportTimeoutMs: 60_000 }, request));
    expect(later.provenance.result).toBe(result(2));
    expect(counters.report_jobs_created).toBe(2);
    expect(cache.get(KEY)).toMatchObject({ kind: 'done', result: result(2) });
    expect(lines.filter((e) => e.msg === 'report.cached_result_gone')).toEqual([
      expect.objectContaining({ tool: 'test', result: result(1), source: 'resume' }),
    ]);
  });

  it('a resumed run whose re-run result is also gone fails once, and the next call after that starts fresh', async () => {
    const outcomes: Record<number, 'failed' | 'never'> = { 1: 'never' };
    const expired: string[] = [];
    const cache = createReportCache({ networkCode: NETWORK });
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: outcomes, expiredResults: expired },
      { reportCache: cache, reportTimeoutMs: 0 },
    );
    expect(await executeReport(ctx, request)).toMatchObject({ error: { code: 'REPORT_TIMEOUT' } });
    delete outcomes[1];
    expired.push(result(1), result(2));
    expect(await executeReport({ ...ctx, reportTimeoutMs: 60_000 }, request)).toMatchObject({
      error: { code: 'REPORT_RESULT_EXPIRED', details: { result: result(2) } },
    });
    expect(counters.report_jobs_created).toBe(2);
    expect(cache.get(KEY)).toBeUndefined();
    const later = ok(await executeReport({ ...ctx, reportTimeoutMs: 60_000 }, request));
    expect(later.provenance.result).toBe(result(3));
    expect(counters.report_jobs_created).toBe(3);
  });

  it('after a poll that could not reach GAM, the next call waits for the same operation', async () => {
    const { ctx, counters } = counted({ reports: [{ query, rows }] }, { reportCache: createReportCache({ networkCode: NETWORK }) });
    const inner = ctx.client;
    let unreachable = true;
    ctx.client = {
      ...inner,
      pollOperation: async (op) => {
        if (unreachable) throw new TypeError('fetch failed');
        return inner.pollOperation(op);
      },
    };
    expect(await executeReport(ctx, request)).toMatchObject({
      error: { code: 'INTERNAL_ERROR', details: { operation: operation(1) } },
    });
    unreachable = false;
    expect(ok(await executeReport(ctx, request)).provenance.result).toBe(result(1));
    expect(counters.report_jobs_created).toBe(1);
  });

  it('F6: after QUOTA_EXCEEDED while polling, the next call waits for the same operation', async () => {
    const gam = createFakeGam();
    gam.setRows([{ dimensionValues: [int(1)], metricValueGroups: [{ primaryValues: [int(5)] }] }]);
    for (let i = 0; i < 4; i++) gam.inject('GET', /^networks\/1234\/operations\//, { status: 429 });
    const ctx = restCtx(gam, { reportCache: createReportCache({ networkCode: NETWORK }) }, true);
    expect(await executeReport(ctx, request)).toMatchObject({
      error: { code: 'QUOTA_EXCEEDED', details: { operation: operation(1) } },
    });
    expect(ok(await executeReport(ctx, request)).provenance.result).toBe(result(1));
    expect(gam.requests.filter((q) => q.method === 'POST' && q.path.endsWith(':run'))).toHaveLength(1);
  });

  it('records a run as pending as soon as it starts, with the time it started', async () => {
    let t = Date.parse('2026-09-17T04:00:00Z');
    const cache = createReportCache({ networkCode: NETWORK, now: () => t });
    const seen: unknown[] = [];
    const { ctx } = counted({ reports: [{ query, rows }], runOutcomes: { 1: 'never' } }, { reportCache: cache, reportTimeoutMs: 0 });
    const inner = ctx.client;
    ctx.client = {
      ...inner,
      // Each poll takes a minute; the first one sees what the cache holds.
      pollOperation: async (op) => {
        if (seen.length === 0) seen.push(cache.get(KEY));
        t += 60_000;
        return inner.pollOperation(op);
      },
    };
    expect(await executeReport(ctx, request)).toMatchObject({ error: { code: 'REPORT_TIMEOUT' } });
    const started = { kind: 'pending', operation: operation(1), started_at: '2026-09-17T04:00:00.000Z' };
    expect(seen).toEqual([expect.objectContaining(started)]);
    expect(cache.get(KEY)).toMatchObject(started);
  });

  it('after the first page could not be read, the next call waits for the same operation', async () => {
    const gam = createFakeGam();
    gam.setRows([{ dimensionValues: [int(1)], metricValueGroups: [{ primaryValues: [int(5)] }] }]);
    for (let i = 0; i < 4; i++) gam.inject('GET', /:fetchRows\?/, { status: 503 });
    const cache = createReportCache({ networkCode: NETWORK });
    const ctx = restCtx(gam, { reportCache: cache }, true);
    expect(await executeReport(ctx, request)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(cache.get(KEY)).toMatchObject({ kind: 'pending', operation: operation(1) });
    expect(ok(await executeReport(ctx, request)).provenance).toMatchObject({ result: result(1), cache: { hit: false } });
    expect(gam.requests.filter((q) => q.method === 'POST' && q.path.endsWith(':run'))).toHaveLength(1);
    expect(cache.get(KEY)).toMatchObject({ kind: 'done', result: result(1) });
  });

  it('a second process sharing the cache directory waits for a run the first one is still polling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gam-shared-cache-'));
    const gam = createFakeGam();
    gam.setRows([{ dimensionValues: [int(1)], metricValueGroups: [{ primaryValues: [int(5)] }] }]);
    const processOn = (sleep?: () => Promise<void>) => restCtx(gam, {
      reportCache: createReportCache({ networkCode: NETWORK, diskDir: dir }),
      ...(sleep && { sleep }),
    });
    const polling = gate();
    const release = gate();
    const first = executeReport(processOn(async () => { polling.open(); await release.opened; }), request);
    return (async () => {
      await polling.opened; // the first process has run the report and is between two polls
      const second = ok(await executeReport(processOn(), request));
      release.open();
      expect(second.provenance.result).toBe(result(1));
      expect(ok(await first).provenance.result).toBe(result(1));
      expect(gam.requests.filter((q) => q.method === 'POST' && q.path.endsWith(':run'))).toHaveLength(1);
    })().finally(() => rmSync(dir, { recursive: true, force: true }));
  });
});
