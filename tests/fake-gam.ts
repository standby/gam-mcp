// In-process fake of the Ad Manager REST endpoints the client uses. Tests hand
// its `fetch` to createRestGamClient, so the real client code runs. Every
// request is logged; outcomes can be injected per request.
import type { ReportRow, ReportValue } from '../src/values.js';

const BASE = 'https://admanager.googleapis.com/v1/';

export const int = (n: number | string): ReportValue => ({ intValue: String(n) });
export const dbl = (n: number): ReportValue => ({ doubleValue: n });
export const str = (s: string): ReportValue => ({ stringValue: s });

// H7 (spec §7.2): the only writes the client may send are creating a report
// and running one. The guard below scans a request log for anything else —
// whichever fake received it — and tests/setup.ts fails the test that sent
// it. `findViolations` is the guard itself, exported so a permanent test can
// exercise its logic directly against a fabricated log, without a fake GAM.
const ALLOWED_POSTS = [/^networks\/\d+\/reports$/, /^networks\/\d+\/reports\/\d+:run$/];
const violations: string[] = [];

export function findViolations(log: { method: string; path: string }[]): string[] {
  return log.reduce<string[]>((found, { method, path }) => {
    const pathname = path.split('?')[0];
    if (method !== 'GET' && !(method === 'POST' && ALLOWED_POSTS.some((re) => re.test(pathname)))) {
      found.push(`${method} ${pathname}`);
    }
    return found;
  }, []);
}

// Returns and clears everything recorded so far.
export function takeViolations(): string[] {
  return violations.splice(0);
}

type Json = Record<string, any>;
export type LoggedRequest = { method: string; path: string; body?: Json };
export type Outcome =
  | { status: number; body?: unknown }
  | 'network-error'
  // Perform the request, then answer with this status (a lost response).
  | { succeedThenStatus: number };

export type FakeGam = {
  fetch: typeof fetch;
  requests: LoggedRequest[];
  reports: Map<string, { name: string; displayName?: string; reportDefinition: Json }>;
  network: Json;
  setRows(rows: ReportRow[], extra?: { runTime?: string; dateRanges?: Json[] }): void;
  inject(method: string, path: RegExp, outcome: Outcome): void;
  expire(result: string): void;
};

export function createFakeGam(opts: { networkCode?: string; completeAfterPolls?: number } = {}): FakeGam {
  const code = opts.networkCode ?? '1234';
  const completeAfter = opts.completeAfterPolls ?? 1;
  const requests: LoggedRequest[] = [];
  const reports = new Map<string, { name: string; displayName?: string; reportDefinition: Json }>();
  const runs = new Map<string, { report: string; run: number; polls: number }>();
  const expired = new Set<string>();
  const injections: { method: string; path: RegExp; outcome: Outcome }[] = [];
  let rows: ReportRow[] = [];
  let extra: { runTime?: string; dateRanges?: Json[] } = {};
  let reportSeq = 0;
  let runSeq = 0;

  const network: Json = {
    name: `networks/${code}`,
    networkCode: code,
    displayName: 'Test network',
    timeZone: 'Asia/Tokyo',
    currencyCode: 'USD',
    secondaryCurrencyCodes: ['EUR'],
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const notFound = () => json(404, { error: { code: 404, status: 'NOT_FOUND' } });

  function route(method: string, path: string, body: Json | undefined): Response {
    const [pathname, query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    let m: RegExpMatchArray | null;

    if (method === 'GET' && pathname === `networks/${code}`) return json(200, network);

    if (method === 'POST' && pathname === `networks/${code}/reports`) {
      const name = `networks/${code}/reports/${++reportSeq}`;
      const report = { name, ...(body?.displayName && { displayName: body.displayName }), reportDefinition: body?.reportDefinition ?? {} };
      reports.set(name, report);
      return json(200, report);
    }

    if (method === 'GET' && pathname === `networks/${code}/reports`) {
      const filter = params.get('filter');
      let list = [...reports.values()];
      if (filter !== null) {
        const f = /^displayName = "(.*)"$/.exec(filter);
        if (!f) return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'unsupported filter' } });
        list = list.filter((r) => r.displayName === f[1]);
      }
      return json(200, list.length ? { reports: list } : {});
    }

    if ((m = /^(networks\/\d+\/reports\/\d+)$/.exec(pathname)) && method === 'GET') {
      const r = reports.get(m[1]);
      return r ? json(200, r) : notFound();
    }

    if ((m = /^(networks\/\d+\/reports\/\d+):run$/.exec(pathname)) && method === 'POST') {
      if (!reports.has(m[1])) return notFound();
      const run = ++runSeq;
      const name = `networks/${code}/operations/reports/runs/${run}`;
      runs.set(name, { report: m[1], run, polls: 0 });
      return json(200, { name });
    }

    if ((m = /^(networks\/\d+\/operations\/reports\/runs\/\d+)$/.exec(pathname)) && method === 'GET') {
      const op = runs.get(m[1]);
      if (!op) return notFound();
      op.polls += 1;
      if (op.polls <= completeAfter) return json(200, { name: m[1] });
      return json(200, { name: m[1], done: true, response: { reportResult: `${op.report}/results/${op.run}` } });
    }

    if ((m = /^(networks\/\d+\/reports\/(\d+)\/results\/\d+):fetchRows$/.exec(pathname)) && method === 'GET') {
      const result = m[1];
      const report = reports.get(result.split('/results/')[0]);
      if (!report || expired.has(result)) return notFound();
      const pageSize = Math.min(Number(params.get('pageSize') ?? 1000), 10_000);
      const token = params.get('pageToken');
      if (token !== null && !/^\d+$/.test(token)) {
        return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'invalid page token' } });
      }
      const offset = token ? Number(token) : 0;
      const page: Json = { rows: rows.slice(offset, offset + pageSize) };
      if (offset + pageSize < rows.length) page.nextPageToken = String(offset + pageSize);
      if (!token) {
        page.runTime = extra.runTime ?? '2026-09-03T01:00:00Z';
        page.dateRanges = extra.dateRanges ?? [{
          startDate: report.reportDefinition.dateRange?.fixed?.startDate,
          endDate: report.reportDefinition.dateRange?.fixed?.endDate,
        }];
        if (rows.length > 0) page.totalRowCount = rows.length;
      }
      if (page.rows.length === 0) delete page.rows;
      return json(200, page);
    }

    return notFound();
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const body = typeof init?.body === 'string' && init.body.length ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, ...(body !== undefined && { body }) });
    violations.push(...findViolations([{ method, path }]));

    const i = injections.findIndex((x) => x.method === method && x.path.test(path));
    if (i >= 0) {
      const { outcome } = injections.splice(i, 1)[0];
      if (outcome === 'network-error') throw new TypeError('fetch failed');
      if ('succeedThenStatus' in outcome) {
        route(method, path, body);
        return json(outcome.succeedThenStatus, { error: { code: outcome.succeedThenStatus } });
      }
      return json(outcome.status, outcome.body ?? { error: { code: outcome.status } });
    }
    return route(method, path, body);
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    requests,
    reports,
    network,
    setRows(next, more = {}) { rows = next; extra = more; },
    inject(method, path, outcome) { injections.push({ method, path, outcome }); },
    expire(result) { expired.add(result); },
  };
}
