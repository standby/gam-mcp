// In-process fake of the Ad Manager REST endpoints the client uses. Tests hand
// its `fetch` to createRestGamClient, so the real client code runs. Every
// request is logged; outcomes can be injected per request.
import type { ReportRow, ReportValue } from '../src/values.js';

const BASE = 'https://admanager.googleapis.com/v1/';

export const int = (n: number | string): ReportValue => ({ intValue: String(n) });
export const dbl = (n: number): ReportValue => ({ doubleValue: n });
export const str = (s: string): ReportValue => ({ stringValue: s });

// H7 (spec §7.2): the only writes the client may send are creating a report
// in its own network and running one of that network's reports. The guard
// below scans a request log for anything else — whichever fake received it —
// and tests/setup.ts fails the test that sent it. `findViolations` is the
// guard itself, exported so a permanent test can exercise its logic directly
// against a fabricated log, without a fake GAM.
const violations: string[] = [];

export function findViolations(log: { method: string; path: string }[], networkCode: string): string[] {
  const allowedPosts = [
    new RegExp(`^networks/${networkCode}/reports$`),
    new RegExp(`^networks/${networkCode}/reports/\\d+:run$`),
  ];
  return log.reduce<string[]>((found, { method, path }) => {
    const pathname = path.split('?')[0];
    if (method !== 'GET' && !(method === 'POST' && allowedPosts.some((re) => re.test(pathname)))) {
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
// Rows keyed by column name. The fake encodes each one in the column order of
// the report whose result is fetched, as GAM does, so a caller that decodes
// with another order reads values under the wrong names.
export type RowsByColumn = { byColumn: Record<string, ReportValue>[] };
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
  setRows(rows: ReportRow[] | RowsByColumn, extra?: { runTime?: string; dateRanges?: Json[] }): void;
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
  let rows: ReportRow[] | RowsByColumn = [];
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

  function rowsFor(definition: Json): ReportRow[] {
    if (Array.isArray(rows)) return rows;
    const dimensions: string[] = definition.dimensions ?? [];
    const metrics: string[] = definition.metrics ?? [];
    return rows.byColumn.map((r) => ({
      dimensionValues: dimensions.map((d) => r[d] ?? {}),
      metricValueGroups: [{ primaryValues: metrics.map((m) => r[m] ?? {}) }],
    }));
  }

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
      const all = rowsFor(report.reportDefinition);
      const page: Json = { rows: all.slice(offset, offset + pageSize) };
      if (offset + pageSize < all.length) page.nextPageToken = String(offset + pageSize);
      if (!token) {
        page.runTime = extra.runTime ?? '2026-09-03T01:00:00Z';
        page.dateRanges = extra.dateRanges ?? [{
          startDate: report.reportDefinition.dateRange?.fixed?.startDate,
          endDate: report.reportDefinition.dateRange?.fixed?.endDate,
        }];
        if (all.length > 0) page.totalRowCount = all.length;
      }
      if (page.rows.length === 0) delete page.rows;
      return json(200, page);
    }

    return notFound();
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // fetch takes its URL, method and body from a Request unless init overrides them.
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    let text = typeof init?.body === 'string' ? init.body : '';
    if (request && init?.body === undefined) text = await request.clone().text();
    const body = text.length ? JSON.parse(text) : undefined;
    requests.push({ method, path, ...(body !== undefined && { body }) });
    violations.push(...findViolations([{ method, path }], code));

    // D5: every report is created in the network's zone and currency.
    const pathname = path.split('?')[0];
    if (method === 'POST' && /^networks\/\d+\/reports$/.test(pathname)) {
      const d = body?.reportDefinition;
      if (d?.timeZoneSource !== 'PUBLISHER' || d?.currencyCode !== network.currencyCode || (d && 'timeZone' in d)) {
        violations.push(`POST ${pathname} without timeZoneSource PUBLISHER and currencyCode ${network.currencyCode}`);
      }
    }

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
