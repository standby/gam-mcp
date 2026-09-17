import { describe, it, expect } from 'vitest';
import { executeReport } from '../src/report-exec.js';
import { createReportCache, PENDING_TTL_MS } from '../src/cache.js';
import { definitionHash } from '../src/report-key.js';
import { createRestGamClient, withRetries } from '../src/gam-client-rest.js';
import { createLogger } from '../src/log.js';
import { createFakeGam, int } from './fake-gam.js';
import { counted, definitionFor, makeCtx, NETWORK, ok } from './helpers.js';

const RANGE = { start: '2026-09-01', end: '2026-09-02' };
const query = { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] };
const request = { tool: 'test', query, dateRange: RANGE, summary: 'S' };
const rows = [{ AD_UNIT_ID: 1, IMPRESSIONS: 5 }];
const KEY = definitionHash(definitionFor(query, RANGE));
const operation = (run: number) => `networks/${NETWORK}/operations/reports/runs/${run}`;
const result = (run: number) => `networks/${NETWORK}/reports/1/results/${run}`;

describe('shared runs (spec §2.6)', () => {
  it('F1: two concurrent identical calls share one create, run and poll sequence', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'info', sink: (l) => { lines.push(JSON.parse(l)); } });
    const { ctx, counters } = counted({ reports: [{ query, rows }] }, { reportCache: createReportCache(), logger });
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
    const { ctx, counters } = counted({ reports: [{ query, rows }] }, { reportCache: createReportCache() });
    const other = { ...request, dateRange: { start: '2026-09-03', end: '2026-09-04' } };
    const [a, b] = await Promise.all([executeReport(ctx, request), executeReport(ctx, other)]);
    expect(ok(a).provenance.report).not.toBe(ok(b).provenance.report);
    expect(counters).toMatchObject({ report_definitions_created: 2, report_jobs_created: 2 });
  });

  it('F3: a failed shared run fails both callers, and the next call starts fresh', async () => {
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: { 1: 'failed' } },
      { reportCache: createReportCache() },
    );
    const [a, b] = await Promise.all([executeReport(ctx, request), executeReport(ctx, request)]);
    expect(a).toMatchObject({ error: { code: 'REPORT_FAILED' } });
    expect(b).toEqual(a);
    expect(counters.report_jobs_created).toBe(1);
    expect(ok(await executeReport(ctx, request)).provenance.result).toBe(result(2));
    expect(counters.report_jobs_created).toBe(2);
  });
});

describe('runs that outlive their caller (spec §2.6)', () => {
  it('F4: after REPORT_TIMEOUT the next identical call waits for the same operation', async () => {
    const outcomes: Record<number, 'failed' | 'never'> = { 1: 'never' };
    const cache = createReportCache();
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: outcomes },
      { reportCache: cache, reportTimeoutMs: 0 },
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
  });

  it('F4: a run that times out again keeps its first start time', async () => {
    let t = Date.parse('2026-09-17T04:00:00Z');
    const cache = createReportCache({ now: () => t });
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
    const { ctx, counters } = counted(
      { reports: [{ query, rows }], runOutcomes: { 1: 'never' } },
      { reportCache: createReportCache({ now: () => t }), reportTimeoutMs: 0 },
    );
    await executeReport(ctx, request);
    t += PENDING_TTL_MS;
    const later = ok(await executeReport({ ...ctx, reportTimeoutMs: 60_000 }, request));
    expect(later.provenance.result).toBe(result(2));
    expect(counters.report_jobs_created).toBe(2);
  });

  it('forgets a resumed run that GAM reports failed', async () => {
    const outcomes: Record<number, 'failed' | 'never'> = { 1: 'never' };
    const cache = createReportCache();
    const { ctx } = counted({ reports: [{ query, rows }], runOutcomes: outcomes }, { reportCache: cache, reportTimeoutMs: 0 });
    await executeReport(ctx, request);
    outcomes[1] = 'failed';
    expect(await executeReport(ctx, request)).toMatchObject({ error: { code: 'REPORT_FAILED' } });
    expect(cache.get(KEY)).toBeUndefined();
  });

  it('after a poll that could not reach GAM, the next call waits for the same operation', async () => {
    const { ctx, counters } = counted({ reports: [{ query, rows }] }, { reportCache: createReportCache() });
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
    const client = createRestGamClient({ networkCode: NETWORK, fetchImpl: withRetries(gam.fetch, { baseDelayMs: 1 }) });
    const ctx = makeCtx({}, { client, reportCache: createReportCache() });
    expect(await executeReport(ctx, request)).toMatchObject({
      error: { code: 'QUOTA_EXCEEDED', details: { operation: operation(1) } },
    });
    expect(ok(await executeReport(ctx, request)).provenance.result).toBe(result(1));
    expect(gam.requests.filter((q) => q.method === 'POST' && q.path.endsWith(':run'))).toHaveLength(1);
  });
});
