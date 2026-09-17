import { describe, it, expect } from 'vitest';
import { executeReport } from '../src/report-exec.js';
import { definitionHash, reportName } from '../src/report-key.js';
import { REUSE_MAP_MAX } from '../src/report-reuse.js';
import { createLogger } from '../src/log.js';
import type { Provenance, ResultEnvelope } from '../src/envelope.js';
import type { ToolContext } from '../src/report-tool-builder.js';
import { createFakeGam, int, type FakeGam } from './fake-gam.js';
import { definitionFor, restCtx, NETWORK } from './helpers.js';
import { createReportCache } from '../src/cache.js';

// These run against the fake GAM, which stores whatever body it was sent and
// can hold a report planted with a different definition under the same name.
// The mock client only ever lists what it was handed, so a comparison against
// it would be true by construction (B5).
const RANGE = { start: '2026-09-01', end: '2026-09-02' };
const QUERY = { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] };
const REQUEST = { tool: 'test', query: QUERY, dateRange: RANGE, summary: 'S' };
const DEFINITION = definitionFor(QUERY, RANGE);
const NAME = reportName(definitionHash(DEFINITION));
const CREATE = /^networks\/1234\/reports$/;
const LIST = /^networks\/1234\/reports\?/;
const RUN = /:run$/;

function fakeWithRows(): FakeGam {
  const gam = createFakeGam();
  gam.setRows([{ dimensionValues: [int(1)], metricValueGroups: [{ primaryValues: [int(10)] }] }]);
  return gam;
}

// A new client stands for a new process: nothing is remembered for it.
function processOn(gam: FakeGam, over: Partial<ToolContext> = {}, retries = false): ToolContext {
  return restCtx(gam, over, retries);
}

const count = (gam: FakeGam, method: string, path: RegExp, from = 0) =>
  gam.requests.slice(from).filter((r) => r.method === method && path.test(r.path)).length;

function provenance(r: unknown): Provenance {
  if (r && typeof r === 'object' && 'error' in r) throw new Error(JSON.stringify(r));
  return (r as ResultEnvelope).provenance as Provenance;
}

describe('report reuse (spec §2.2)', () => {
  it('creates a report named after its definition, listing the name first', async () => {
    const gam = fakeWithRows();
    const p = provenance(await executeReport(processOn(gam), REQUEST));
    expect(gam.reports.get(p.report)?.displayName).toBe(NAME);
    const list = gam.requests.find((r) => LIST.test(r.path))!;
    expect(new URLSearchParams(list.path.split('?')[1]).get('filter')).toBe(`displayName = "${NAME}"`);
  });

  it('B2: a fresh process finds the report by name and runs it without creating one', async () => {
    const gam = fakeWithRows();
    await executeReport(processOn(gam), REQUEST);
    const from = gam.requests.length;
    const p = provenance(await executeReport(processOn(gam), REQUEST));
    expect(count(gam, 'GET', LIST, from)).toBe(1);
    expect(count(gam, 'POST', CREATE, from)).toBe(0);
    expect(count(gam, 'POST', RUN, from)).toBe(1);
    expect(p.report).toBe(`networks/${NETWORK}/reports/1`);
    expect(gam.reports.size).toBe(1);
  });

  it('B3: the same process with the result cache off reuses the report it remembers: no list, no create', async () => {
    const gam = fakeWithRows();
    const ctx = processOn(gam, { reportCache: createReportCache({ ttlMs: 0 }) });
    await executeReport(ctx, REQUEST);
    const from = gam.requests.length;
    const p = provenance(await executeReport(ctx, REQUEST));
    expect(count(gam, 'GET', LIST, from)).toBe(0);
    expect(count(gam, 'POST', CREATE, from)).toBe(0);
    expect(count(gam, 'POST', RUN, from)).toBe(1);
    expect(p.report).toBe(`networks/${NETWORK}/reports/1`);
  });

  it('B4: when GAM rejects the name filter, the call creates the report, succeeds, and logs once', async () => {
    const gam = fakeWithRows();
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => { lines.push(JSON.parse(l)); } });
    const ctx = processOn(gam, { logger });
    for (const day of ['2026-09-01', '2026-09-02']) {
      gam.inject('GET', LIST, { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT' } } });
      provenance(await executeReport(ctx, { ...REQUEST, dateRange: { start: day, end: day } }));
    }
    expect(count(gam, 'POST', CREATE)).toBe(2);
    const rejected = lines.filter((e) => e.msg === 'report.list_filter_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ level: 'warn', tool: 'test', status: 400 });
  });

  it('B5: a listed report with the right name but another stored definition is not reused', async () => {
    const gam = fakeWithRows();
    gam.reports.set('networks/1234/reports/77', {
      name: 'networks/1234/reports/77',
      displayName: NAME,
      reportDefinition: { ...DEFINITION, metrics: ['AD_REQUESTS'] },
    });
    const p = provenance(await executeReport(processOn(gam), REQUEST));
    expect(p.report).toBe(`networks/${NETWORK}/reports/1`);
    expect(count(gam, 'POST', CREATE)).toBe(1);
    expect(gam.reports.size).toBe(2);
  });

  it('reuses a listed report whose stored definition differs only in order', async () => {
    const gam = fakeWithRows();
    const query = { dimensions: ['AD_UNIT_ID', 'DATE'], metrics: ['IMPRESSIONS', 'AD_REQUESTS'] };
    const definition = definitionFor(query, RANGE);
    gam.reports.set('networks/1234/reports/77', {
      name: 'networks/1234/reports/77',
      displayName: reportName(definitionHash(definition)),
      reportDefinition: JSON.parse(JSON.stringify({
        ...definition,
        dimensions: [...definition.dimensions].reverse(),
        metrics: [...definition.metrics].reverse(),
      })),
    });
    const p = provenance(await executeReport(processOn(gam), { ...REQUEST, query }));
    expect(p.report).toBe('networks/1234/reports/77');
    expect(count(gam, 'POST', CREATE)).toBe(0);
  });

  it('C5: a create whose answer was lost is found by name on the next call; GAM holds one report', async () => {
    const gam = fakeWithRows();
    gam.inject('POST', CREATE, { succeedThenStatus: 503 });
    const ctx = processOn(gam, {}, true);
    expect(await executeReport(ctx, REQUEST)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    const p = provenance(await executeReport(ctx, REQUEST));
    expect(p.report).toBe(`networks/${NETWORK}/reports/1`);
    expect(count(gam, 'POST', CREATE)).toBe(1);
    expect(gam.reports.size).toBe(1);
  });

  it('C6: after a run answered 503, the next call runs the same report again', async () => {
    const gam = fakeWithRows();
    gam.inject('POST', RUN, { status: 503 });
    const ctx = processOn(gam, {}, true);
    expect(await executeReport(ctx, REQUEST)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(count(gam, 'POST', RUN)).toBe(1);
    const p = provenance(await executeReport(ctx, REQUEST));
    expect(p.report).toBe(`networks/${NETWORK}/reports/1`);
    expect(count(gam, 'POST', CREATE)).toBe(1);
    expect(count(gam, 'POST', RUN)).toBe(2);
  });

  it('remembers up to 1,000 report names per client', () => {
    expect(REUSE_MAP_MAX).toBe(1000);
  });
});
