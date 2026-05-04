import { writeFileSync } from 'node:fs';

export type EntityType =
  | 'advertiser' | 'order' | 'line_item' | 'ad_unit' | 'creative' | 'placement' | 'company'
  | 'custom_targeting_key';

export type Entity = { id: number; name: string; [k: string]: unknown };

export type ReportQuery = {
  dimensions: string[];
  metrics: string[];
  filters?: { field: string; op: '=' | 'IN' | '!=' | 'CONTAINS' | 'NOT_CONTAINS'; value: number | string | (number | string)[] }[];
  // Maps each CUSTOM_DIMENSION_<N>_VALUE dimension to a publisher-configured
  // custom-targeting-key ID by index. Required by GAM REST when those
  // dimensions are used; ignored otherwise.
  custom_dimension_key_ids?: number[];
};

export type ReportOperation = { operation_name: string };

export type OperationStatus =
  | { state: 'pending' }
  | { state: 'running' }
  | { state: 'done'; download_url: string }
  | { state: 'failed'; reason: string };

export type DateRange = { start: string; end: string };

export type GAMClient = {
  listEntities: (q: { entity_type: EntityType; query?: string; ids?: number[] }) => Promise<Entity[]>;
  createReport: (query: ReportQuery, dateRange: DateRange) => Promise<ReportOperation>;
  pollOperation: (operation_name: string) => Promise<OperationStatus>;
  downloadReport: (downloadUrl: string, destPath: string) => Promise<string>;
};

// ------------------------- in-memory mock for tests ------------------------

export type ReportFixture = {
  query: ReportQuery;
  dateRange?: DateRange;
  csvGz: Buffer;
};

export type MockState = {
  entities?: Partial<Record<EntityType, Entity[]>>;
  reports?: ReportFixture[];
};

export function createMockGamClient(state: MockState = {}): GAMClient {
  const reports = state.reports ?? [];
  const operations = new Map<string, { fixture: ReportFixture; polledCount: number }>();
  let counter = 0;

  const matchFixture = (q: ReportQuery, dr?: DateRange): ReportFixture | undefined =>
    reports.find((r) =>
      sameDimsMetrics(r.query, q) &&
      (!r.dateRange || (dr?.start === r.dateRange.start && dr?.end === r.dateRange.end)),
    );

  return {
    async listEntities({ entity_type, query, ids }) {
      const all = state.entities?.[entity_type] ?? [];
      if (ids?.length) return all.filter((e) => ids.includes(e.id));
      if (!query) return all;
      const q = query.toLowerCase();
      return all.filter((e) => e.name.toLowerCase().includes(q));
    },
    async createReport(query, dateRange) {
      const fixture = matchFixture(query, dateRange);
      if (!fixture) {
        throw new Error(
          `mock: no report fixture matches query dimensions=${query.dimensions.join(',')} metrics=${query.metrics.join(',')}`,
        );
      }
      const name = `operations/${++counter}`;
      operations.set(name, { fixture, polledCount: 0 });
      return { operation_name: name };
    },
    async pollOperation(name) {
      const op = operations.get(name);
      if (!op) return { state: 'failed', reason: 'unknown operation' };
      op.polledCount++;
      if (op.polledCount === 1) {
        return { state: 'running' };
      }
      return { state: 'done', download_url: `mock://${name}` };
    },
    async downloadReport(downloadUrl, destPath) {
      const name = downloadUrl.replace(/^mock:\/\//, '');
      const op = operations.get(name);
      if (!op) throw new Error(`mock: unknown download ${downloadUrl}`);
      writeFileSync(destPath, op.fixture.csvGz);
      return destPath;
    },
  };
}

function sameDimsMetrics(a: ReportQuery, b: ReportQuery): boolean {
  const sa = new Set(a.dimensions); const sb = new Set(b.dimensions);
  const ma = new Set(a.metrics);    const mb = new Set(b.metrics);
  return setEq(sa, sb) && setEq(ma, mb);
}
function setEq<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
