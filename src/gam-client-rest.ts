import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type {
  GAMClient,
  EntityType,
  ReportQuery,
  ReportOperation,
  OperationStatus,
  Entity,
  DateRange,
} from './gam-client.js';
import { gamError } from './errors.js';

const BASE = 'https://admanager.googleapis.com/v1';

const ENTITY_PATH: Record<EntityType, { collection: string; idField: string }> = {
  advertiser: { collection: 'companies',  idField: 'companyId' },
  company:    { collection: 'companies',  idField: 'companyId' },
  order:      { collection: 'orders',     idField: 'orderId' },
  line_item:  { collection: 'lineItems',  idField: 'lineItemId' },
  ad_unit:    { collection: 'adUnits',    idField: 'adUnitId' },
  creative:   { collection: 'creatives',  idField: 'creativeId' },
  placement:  { collection: 'placements', idField: 'placementId' },
};

type ReportValue = { stringValue?: string; intValue?: number; doubleValue?: number };

function toDateParts(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function extractValue(rv: ReportValue | null | undefined): string {
  if (!rv) return '';
  if (rv.stringValue !== undefined) return rv.stringValue;
  if (rv.intValue !== undefined) return String(rv.intValue);
  if (rv.doubleValue !== undefined) return String(rv.doubleValue);
  return '';
}

function csvQuote(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function createRestGamClient(opts: {
  networkCode: string;
  fetchImpl?: typeof fetch;
}): GAMClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const networkPath = `${BASE}/networks/${opts.networkCode}`;

  // Keyed by report resource name (e.g. networks/xxx/reports/yyy) so downloadReport can build CSV headers.
  const reportQueryCache = new Map<string, { dimensions: string[]; metrics: string[] }>();

  return {
    async listEntities({ entity_type, query, ids }) {
      const meta = ENTITY_PATH[entity_type];
      const params = new URLSearchParams();
      params.set('pageSize', '200');
      if (query) params.set('filter', `name:CONTAINS:${JSON.stringify(query)}`);
      if (ids?.length) params.set('filter', ids.map((i) => `${meta.idField}=${i}`).join(' OR '));
      const url = `${networkPath}/${meta.collection}?${params}`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`listEntities ${res.status}: ${await res.text()}`);
      const json = await res.json() as Record<string, unknown>;
      const list = (json[meta.collection] as any[] | undefined) ?? [];
      return list.map((e): Entity => {
        // GAM REST returns `name` as a resource path (networks/X/collection/ID).
        // Some collections (e.g. adUnits) omit the explicit numeric ID field, so
        // fall back to parsing the trailing segment of the path.
        const explicitId = e[meta.idField];
        const resourceName = String(e.name ?? '');
        const id = explicitId !== undefined && explicitId !== null
          ? Number(explicitId)
          : Number(resourceName.split('/').pop());
        // Prefer displayName (human-readable) over the resource path.
        const label = String(e.displayName ?? e.name ?? '');
        return { id, name: label };
      });
    },

    async createReport(query: ReportQuery, dateRange: DateRange): Promise<ReportOperation> {
      // Step 1: create the report resource
      const body = {
        reportDefinition: {
          dimensions: query.dimensions,
          metrics: query.metrics,
          dateRange: {
            fixed: {
              startDate: toDateParts(dateRange.start),
              endDate: toDateParts(dateRange.end),
            },
          },
          reportType: 'HISTORICAL',
          ...(query.filters?.length && { filter: pqlFromFilters(query.filters) }),
        },
      };
      const createRes = await fetchImpl(`${networkPath}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!createRes.ok) throw new Error(`createReport(create) ${createRes.status}: ${await createRes.text()}`);
      const report = await createRes.json() as { name: string };

      // Cache dims/metrics so downloadReport can write the CSV header later
      reportQueryCache.set(report.name, { dimensions: query.dimensions, metrics: query.metrics });

      // Step 2: run the report → returns an operation
      const runRes = await fetchImpl(`${BASE}/${report.name}:run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!runRes.ok) throw new Error(`createReport(run) ${runRes.status}: ${await runRes.text()}`);
      const op = await runRes.json() as { name: string };
      return { operation_name: op.name };
    },

    async pollOperation(operation_name: string): Promise<OperationStatus> {
      const res = await fetchImpl(`${BASE}/${operation_name}`);
      if (res.status === 429) return { state: 'failed', reason: 'QUOTA_EXCEEDED' };
      if (!res.ok) throw new Error(`pollOperation ${res.status}: ${await res.text()}`);
      const op = await res.json() as {
        done?: boolean;
        error?: { message: string };
        response?: { reportResult?: string };
      };
      if (!op.done) return { state: 'running' };
      if (op.error) return { state: 'failed', reason: op.error.message };
      const resultPath = op.response?.reportResult;
      if (!resultPath) return { state: 'failed', reason: 'response missing reportResult' };
      return { state: 'done', download_url: resultPath };
    },

    async downloadReport(downloadUrl: string, destPath: string): Promise<string> {
      // HTTP URL fallback (used in tests / future CSV download endpoints)
      if (downloadUrl.startsWith('http')) {
        const res = await fetchImpl(downloadUrl);
        if (!res.ok) throw new Error(`downloadReport ${res.status}: ${await res.text()}`);
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(destPath, buf);
        return destPath;
      }

      // GAM result path: networks/{n}/reports/{id}/results/{rid}
      const reportName = downloadUrl.split('/results/')[0];
      const queryInfo = reportQueryCache.get(reportName);
      const dimensions = queryInfo?.dimensions ?? [];
      const metrics = queryInfo?.metrics ?? [];
      const headers = [...dimensions, ...metrics];

      const csvLines: string[] = [headers.map(csvQuote).join(',')];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ pageSize: '10000' });
        if (pageToken) params.set('pageToken', pageToken);
        const url = `${BASE}/${downloadUrl}:fetchRows?${params}`;
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`fetchRows ${res.status}: ${await res.text()}`);
        const page = await res.json() as {
          rows?: Array<{
            dimensionValues?: ReportValue[];
            metricValueGroups?: Array<{ primaryValues?: ReportValue[] }>;
          }>;
          nextPageToken?: string;
        };
        for (const row of page.rows ?? []) {
          const dimVals = (row.dimensionValues ?? []).map(extractValue);
          const metVals = (row.metricValueGroups?.[0]?.primaryValues ?? []).map(extractValue);
          csvLines.push([...dimVals, ...metVals].map(csvQuote).join(','));
        }
        pageToken = page.nextPageToken;
      } while (pageToken);

      writeFileSync(destPath, gzipSync(Buffer.from(csvLines.join('\n') + '\n')));
      return destPath;
    },
  };
}

function pqlFromFilters(filters: NonNullable<ReportQuery['filters']>): string {
  return filters.map((f) => {
    const v = Array.isArray(f.value)
      ? `(${f.value.map((x) => typeof x === 'string' ? `'${x}'` : String(x)).join(',')})`
      : typeof f.value === 'string' ? `'${f.value}'` : String(f.value);
    return `${f.field} ${f.op} ${v}`;
  }).join(' AND ');
}
