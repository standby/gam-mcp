import { writeFileSync } from 'node:fs';
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

export function createRestGamClient(opts: {
  networkCode: string;
  fetchImpl?: typeof fetch;
}): GAMClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const networkPath = `${BASE}/networks/${opts.networkCode}`;

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
      return list.map((e): Entity => ({
        id: Number(e[meta.idField]),
        name: String(e.name ?? e.displayName ?? ''),
      }));
    },

    async createReport(query: ReportQuery, dateRange: DateRange): Promise<ReportOperation> {
      const body = {
        report: {
          dimensions: query.dimensions,
          metrics: query.metrics,
          dateRange: { startDate: dateRange.start, endDate: dateRange.end },
          ...(query.filters?.length && { filter: pqlFromFilters(query.filters) }),
        },
      };
      const res = await fetchImpl(`${networkPath}/reports:runReport`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`createReport ${res.status}: ${await res.text()}`);
      const op = await res.json() as { name: string };
      return { operation_name: op.name };
    },

    async pollOperation(operation_name: string): Promise<OperationStatus> {
      const res = await fetchImpl(`${BASE}/${operation_name}`);
      if (res.status === 429) return { state: 'failed', reason: 'QUOTA_EXCEEDED' };
      if (!res.ok) throw new Error(`pollOperation ${res.status}: ${await res.text()}`);
      const op = await res.json() as { done?: boolean; error?: { message: string }; response?: { downloadUrl?: string } };
      if (!op.done) return { state: 'running' };
      if (op.error) return { state: 'failed', reason: op.error.message };
      const url = op.response?.downloadUrl;
      if (!url) return { state: 'failed', reason: 'response missing downloadUrl' };
      return { state: 'done', download_url: url };
    },

    async downloadReport(downloadUrl: string, destPath: string): Promise<string> {
      const res = await fetchImpl(downloadUrl);
      if (!res.ok) throw new Error(`downloadReport ${res.status}: ${await res.text()}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(destPath, buf);
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
