import type { ReportType } from './schema.js';
import { fieldType } from './schema.js';
import type { ReportRow, ReportValue } from './values.js';
import { definitionRange, type ReportDefinition } from './report-definition.js';
import { definitionHash, reportName } from './report-key.js';

export type EntityType =
  | 'advertiser' | 'order' | 'line_item' | 'ad_unit' | 'placement' | 'company'
  | 'custom_targeting_key';

// `name` is the canonical short identifier (e.g. `adTagName` "channel_id" on a
// custom_targeting_key, or the displayName on an order/advertiser where GAM
// has only one user-visible label). `displayName` is the longer descriptive
// label when GAM exposes one separately — for custom_targeting_key this is
// the human-readable "Channel ID" while `name` is the API code emitted in
// KEY_VALUES_NAME report rows.
export type Entity = {
  id: number;
  name: string;
  displayName?: string;
  [k: string]: unknown;
};

// Filter mode for listEntities `query`. 'substring' uses the AIP-160
// has-operator (`displayName:"foo"`); 'exact' uses equality on the canonical
// `name` field for custom_targeting_key (GAM accepts `name = "channel_id"`)
// or on `displayName` for entities that only expose displayName.
export type ListEntitiesMatch = 'substring' | 'exact';

export type ReportQuery = {
  dimensions: string[];
  metrics: string[];
  filters?: { field: string; op: '=' | 'IN' | '!=' | 'CONTAINS' | 'NOT_CONTAINS'; value: number | string | (number | string)[] }[];
  // Maps each CUSTOM_DIMENSION_<N>_VALUE dimension to a publisher-configured
  // custom-targeting-key ID by index. Required by GAM REST when those
  // dimensions are used; ignored otherwise.
  custom_dimension_key_ids?: number[];
  // GAM report family. Defaults to HISTORICAL. The UNIQUE_REACH* metrics only
  // exist under REACH — see resolveReportType() in schema.ts, which derives
  // this from the metric list so callers never set it by hand.
  report_type?: ReportType;
  // The single sort a top_n tool asks for. GAM's wire shape (sorts: [{ field:
  // { metric } , descending }]) is built in report-definition.ts, the way
  // toReportFilters already does for filters -- tools speak tool language.
  sort?: { metric: string; descending: boolean };
};

export type OperationStatus =
  | { state: 'pending' }
  | { state: 'running' }
  // `result` is the report result's resource name.
  | { state: 'done'; result: string }
  | { state: 'failed'; reason: string };

export type DateRange = { start: string; end: string };

export type RowsPage = {
  rows: ReportRow[];
  nextPageToken?: string;
  // GAM sends these on the first page only.
  totalRowCount?: number;
  runTime?: string;
  dateRanges?: { start: string; end: string }[];
};

export type StoredReport = { name: string; displayName?: string; definition: ReportDefinition };

// What networks.get says about the network every report runs in.
export type NetworkInfo = { networkCode: string; timeZone: string; currencyCode: string };

// fetchRows throws this when GAM no longer serves a result.
export class ResultUnavailableError extends Error {
  constructor(readonly result: string, readonly status: number) {
    super(`report result ${result} is no longer available (HTTP ${status})`);
    this.name = 'ResultUnavailableError';
  }
}

// A non-2xx answer from GAM. `call` names the client method; `gamStatus` is
// GAM's canonical status (PERMISSION_DENIED, INVALID_ARGUMENT, ...) when the
// body carries one; `detail` is the start of the body.
export class GamHttpError extends Error {
  constructor(
    readonly call: string,
    readonly status: number,
    readonly gamStatus: string | undefined,
    readonly detail: string,
  ) {
    super(`${call} ${status}${gamStatus ? ` ${gamStatus}` : ''}: ${detail}`);
    this.name = 'GamHttpError';
  }
}

// networks.get answered without a field every report needs.
export class NetworkFieldMissingError extends Error {
  constructor(readonly field: 'timeZone' | 'currencyCode') {
    super(`getNetwork: GAM returned no ${field}`);
    this.name = 'NetworkFieldMissingError';
  }
}

// reports.list refused the displayName filter.
export class ReportFilterRejectedError extends Error {
  constructor(readonly status: number) {
    super(`GAM refused the report name filter (HTTP ${status})`);
    this.name = 'ReportFilterRejectedError';
  }
}

export type GAMClient = {
  listEntities: (q: {
    entity_type: EntityType;
    query?: string;
    ids?: number[];
    // Max entities to return. Implementation pages through GAM (200/page)
    // transparently up to this limit. Default 200 (one page).
    limit?: number;
    // How to interpret `query`. Default 'substring'.
    match?: ListEntitiesMatch;
  }) => Promise<Entity[]>;
  // Fetch one raw GAM resource, unmapped. `path` is either network-relative
  // ('lineItems/123') or a full resource name
  // ('networks/{code}/customTargetingValues/456'), which is the shape GAM
  // returns inside nested objects like a line item's targeting. Returns null
  // on 404 so callers can degrade to the raw path instead of throwing.
  getResource: (path: string) => Promise<Record<string, unknown> | null>;
  // The network's identity: its time zone and primary currency (networks.get).
  getNetwork: () => Promise<NetworkInfo>;
  // Throws GamHttpError for any non-2xx answer, 429 included.
  pollOperation: (operation_name: string) => Promise<OperationStatus>;
  // Create a report that runs exactly this definition, named
  // reportName(definitionHash(definition)) so any process can find it again
  // (spec §2.2). Returns its resource name.
  defineReport: (definition: ReportDefinition) => Promise<{ report: string }>;
  // Start a run of an existing report. Returns the operation name to poll.
  runReport: (report: string) => Promise<{ operation: string }>;
  // One page of a finished result. Throws ResultUnavailableError on 404.
  fetchRows: (result: string, page: { pageSize: number; pageToken?: string }) => Promise<RowsPage>;
  // The stored definition of a report, or null if GAM has no such report.
  getReport: (report: string) => Promise<StoredReport | null>;
  // Every report whose displayName is exactly this name, with its stored
  // definition. Throws ReportFilterRejectedError if GAM refuses the filter.
  listReports: (q: { displayName: string }) => Promise<StoredReport[]>;
};

// ------------------------- in-memory mock for tests ------------------------

export type FixtureCell = string | number | boolean | null | undefined | (string | number)[];

export type ReportFixture = {
  query: ReportQuery;
  dateRange?: DateRange;
  // Typed rows keyed by column name, served through defineReport/fetchRows.
  // Numbers become intValue when integral unless the schema types the column
  // as currency or rate; 'YYYY-MM-DD' strings in date columns become YYYYMMDD.
  rows: Record<string, FixtureCell>[];
  runTime?: string;
  // What GAM reports it computed; defaults to the requested range.
  computedDateRange?: { start: string; end: string };
};

export type MockState = {
  entities?: Partial<Record<EntityType, Entity[]>>;
  reports?: ReportFixture[];
  // Raw resources keyed by the path getResource() is called with.
  resources?: Record<string, Record<string, unknown>>;
  networkCode?: string;
  // What getNetwork answers; defaults to Asia/Tokyo and USD.
  network?: { timeZone?: string; currencyCode?: string };
  // Result names fetchRows treats as gone.
  expiredResults?: string[];
  // Operation outcomes by run number (1-based): 'failed' or 'never' (stays running).
  runOutcomes?: Record<number, 'failed' | 'never'>;
};

function toFixtureValue(c: FixtureCell, column: string): ReportValue {
  if (c === null || c === undefined) return {};
  if (Array.isArray(c)) {
    return typeof c[0] === 'number'
      ? { intListValue: { values: c.map(String) } }
      : { stringListValue: { values: c.map(String) } };
  }
  if (typeof c === 'boolean') return { boolValue: c };
  const type = fieldType(column);
  if (typeof c === 'number') {
    return Number.isInteger(c) && type !== 'currency' && type !== 'rate'
      ? { intValue: String(c) }
      : { doubleValue: c };
  }
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(c)) return { intValue: c.replaceAll('-', '') };
  return { stringValue: c };
}

function fixtureRows(fixture: ReportFixture, fields: { dimensions: string[]; metrics: string[] }): ReportRow[] {
  return fixture.rows.map((r) => ({
    dimensionValues: fields.dimensions.map((d) => toFixtureValue(r[d], d)),
    metricValueGroups: [{ primaryValues: fields.metrics.map((m) => toFixtureValue(r[m], m)) }],
  }));
}

export function createMockGamClient(state: MockState = {}): GAMClient {
  const reports = state.reports ?? [];

  const network = state.networkCode ?? '1234';
  const defined = new Map<string, { fixture: ReportFixture; definition: ReportDefinition; range: DateRange; displayName: string }>();
  const runs = new Map<string, { report: string; run: number; polls: number }>();
  let reportSeq = 0;
  let runSeq = 0;

  const matchFixture = (definition: ReportDefinition, range: DateRange): ReportFixture | undefined =>
    reports.find((r) =>
      sameDimsMetrics(r.query, definition) &&
      (!r.dateRange || (range.start === r.dateRange.start && range.end === r.dateRange.end)),
    );

  return {
    async listEntities({ entity_type, query, ids, limit, match }) {
      const all = state.entities?.[entity_type] ?? [];
      let filtered: Entity[];
      if (ids?.length) filtered = all.filter((e) => ids.includes(e.id));
      else if (!query) filtered = all;
      else if (match === 'exact') {
        filtered = all.filter((e) => e.name === query || e.displayName === query);
      } else {
        const q = query.toLowerCase();
        filtered = all.filter((e) =>
          e.name.toLowerCase().includes(q) ||
          (typeof e.displayName === 'string' && e.displayName.toLowerCase().includes(q)),
        );
      }
      return limit !== undefined ? filtered.slice(0, limit) : filtered;
    },
    async getResource(path) {
      return state.resources?.[path] ?? null;
    },
    async getNetwork() {
      return {
        networkCode: network,
        timeZone: state.network?.timeZone ?? 'Asia/Tokyo',
        currencyCode: state.network?.currencyCode ?? 'USD',
      };
    },
    async pollOperation(name) {
      const run = runs.get(name);
      if (!run) return { state: 'failed', reason: 'unknown operation' };
      run.polls += 1;
      const outcome = state.runOutcomes?.[run.run];
      if (outcome === 'failed') return { state: 'failed', reason: 'mock: report failed' };
      if (outcome === 'never' || run.polls === 1) return { state: 'running' };
      const result = `${run.report}/results/${run.run}`;
      return { state: 'done', result };
    },
    async defineReport(definition) {
      const range = definitionRange(definition);
      if (!range) throw new Error('mock: the definition has no fixed date range');
      const fixture = matchFixture(definition, range);
      if (!fixture) {
        throw new Error(
          `mock: no report fixture matches query dimensions=${definition.dimensions.join(',')} metrics=${definition.metrics.join(',')}`,
        );
      }
      const report = `networks/${network}/reports/${++reportSeq}`;
      defined.set(report, { fixture, definition, range, displayName: reportName(definitionHash(definition)) });
      return { report };
    },
    async runReport(report) {
      if (!defined.has(report)) throw new Error(`mock: unknown report ${report}`);
      const run = ++runSeq;
      const operation = `networks/${network}/operations/reports/runs/${run}`;
      runs.set(operation, { report, run, polls: 0 });
      return { operation };
    },
    async fetchRows(result, { pageSize, pageToken }) {
      const d = defined.get(result.split('/results/')[0]);
      if (!d || state.expiredResults?.includes(result)) throw new ResultUnavailableError(result, 404);
      const all = fixtureRows(d.fixture, d.definition);
      if (pageToken !== undefined && !/^\d+$/.test(pageToken)) {
        throw new Error(`fetchRows 400: invalid page token`);
      }
      const size = Math.min(pageSize, 10_000);
      const offset = pageToken ? Number(pageToken) : 0;
      const next = offset + size < all.length ? String(offset + size) : undefined;
      return {
        rows: all.slice(offset, offset + size),
        ...(next && { nextPageToken: next }),
        ...(!pageToken && {
          ...(all.length > 0 && { totalRowCount: all.length }),
          runTime: d.fixture.runTime ?? '2026-01-01T00:00:00Z',
          dateRanges: [d.fixture.computedDateRange ?? d.range],
        }),
      };
    },
    async getReport(report) {
      const d = defined.get(report);
      return d ? { name: report, displayName: d.displayName, definition: d.definition } : null;
    },
    async listReports({ displayName }) {
      return [...defined.entries()]
        .filter(([, d]) => d.displayName === displayName)
        .map(([name, d]) => ({ name, displayName: d.displayName, definition: d.definition }));
    },
  };
}

function sameDimsMetrics(
  a: { dimensions: string[]; metrics: string[] },
  b: { dimensions: string[]; metrics: string[] },
): boolean {
  const sa = new Set(a.dimensions); const sb = new Set(b.dimensions);
  const ma = new Set(a.metrics);    const mb = new Set(b.metrics);
  return setEq(sa, sb) && setEq(ma, mb);
}
function setEq<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
