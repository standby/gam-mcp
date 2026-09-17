import { describe, it, expect } from 'vitest';
import { createRestGamClient, withRetries } from '../src/gam-client-rest.js';
import { GamHttpError, type GAMClient } from '../src/gam-client.js';
import { createFakeGam, type FakeGam } from './fake-gam.js';
import { definitionFor } from './helpers.js';

// Spec §2.3: a GET is retried on a thrown fetch, 429 and 5xx; a POST only on
// 429, the one answer that means GAM did not act on it.
const QUERY = { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] };
const RANGE = { start: '2026-09-01', end: '2026-09-02' };
const CREATE = /^networks\/1234\/reports$/;
const RUN = /^networks\/1234\/reports\/\d+:run$/;
const OPERATION = /^networks\/1234\/operations\//;
const REPORT_1 = /^networks\/1234\/reports\/1$/;

const clientFor = (gam: FakeGam): GAMClient =>
  createRestGamClient({ networkCode: '1234', fetchImpl: withRetries(gam.fetch, { baseDelayMs: 1 }) });
const define = (c: GAMClient) => c.defineReport(definitionFor(QUERY, RANGE));
const sent = (gam: FakeGam, method: string, path: RegExp) =>
  gam.requests.filter((r) => r.method === method && path.test(r.path)).length;

describe('retries (spec §2.3)', () => {
  it('C1: a GET answered 503 is retried and succeeds', async () => {
    const gam = createFakeGam();
    const c = clientFor(gam);
    const { report } = await define(c);
    gam.inject('GET', REPORT_1, { status: 503 });
    expect((await c.getReport(report))?.name).toBe(report);
    expect(sent(gam, 'GET', REPORT_1)).toBe(2);
  });

  it('C1: a GET whose connection fails is retried', async () => {
    const gam = createFakeGam();
    const c = clientFor(gam);
    const { report } = await define(c);
    gam.inject('GET', REPORT_1, 'network-error');
    expect((await c.getReport(report))?.name).toBe(report);
    expect(sent(gam, 'GET', REPORT_1)).toBe(2);
  });

  it('a GET answered 403 is not retried', async () => {
    const gam = createFakeGam();
    const c = clientFor(gam);
    gam.inject('GET', /^networks\/1234\/reports\/7$/, {
      status: 403,
      body: { error: { code: 403, status: 'PERMISSION_DENIED' } },
    });
    const err = await c.getReport('networks/1234/reports/7').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GamHttpError);
    expect(sent(gam, 'GET', /^networks\/1234\/reports\/7$/)).toBe(1);
  });

  it('C2: a create answered 503 is sent once and the error returned', async () => {
    const gam = createFakeGam();
    const c = clientFor(gam);
    gam.inject('POST', CREATE, { status: 503 });
    await expect(define(c)).rejects.toMatchObject({ name: 'GamHttpError', call: 'defineReport', status: 503 });
    expect(sent(gam, 'POST', CREATE)).toBe(1);
    expect(gam.reports.size).toBe(0);
  });

  it('C3: a create whose connection fails is sent once and the error returned', async () => {
    const gam = createFakeGam();
    const c = clientFor(gam);
    gam.inject('POST', CREATE, 'network-error');
    await expect(define(c)).rejects.toThrow('fetch failed');
    expect(sent(gam, 'POST', CREATE)).toBe(1);
    expect(gam.reports.size).toBe(0);
  });

  it('C4: a create answered 429 is retried and exactly one report exists', async () => {
    const gam = createFakeGam();
    const c = clientFor(gam);
    gam.inject('POST', CREATE, { status: 429 });
    const { report } = await define(c);
    expect(report).toBe('networks/1234/reports/1');
    expect(sent(gam, 'POST', CREATE)).toBe(2);
    expect(gam.reports.size).toBe(1);
  });

  it('C6: a run answered 503 is sent once and the error returned', async () => {
    const gam = createFakeGam();
    const c = clientFor(gam);
    const { report } = await define(c);
    gam.inject('POST', RUN, { status: 503 });
    await expect(c.runReport(report)).rejects.toMatchObject({ name: 'GamHttpError', call: 'runReport', status: 503 });
    expect(sent(gam, 'POST', RUN)).toBe(1);
  });

  it('a 429 while polling reaches the caller once retries are spent', async () => {
    const gam = createFakeGam();
    const c = clientFor(gam);
    const { operation } = await c.runReport((await define(c)).report);
    for (let i = 0; i < 4; i++) gam.inject('GET', OPERATION, { status: 429 });
    await expect(c.pollOperation(operation)).rejects.toMatchObject({ name: 'GamHttpError', status: 429 });
    expect(sent(gam, 'GET', OPERATION)).toBe(4);
  });
});
