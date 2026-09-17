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
import { ResultUnavailableError } from './gam-client.js';
import { gamError } from './errors.js';
import type { Logger } from './log.js';
import { noopLogger } from './log.js';
import type { ReportRow, ReportValue } from './values.js';
import { reportDefinition, type GamDate, type ReportDefinition } from './report-definition.js';

const BASE = 'https://admanager.googleapis.com/v1';

const ENTITY_PATH: Record<EntityType, { collection: string; idField: string }> = {
  advertiser: { collection: 'companies',  idField: 'companyId' },
  company:    { collection: 'companies',  idField: 'companyId' },
  order:      { collection: 'orders',     idField: 'orderId' },
  line_item:  { collection: 'lineItems',  idField: 'lineItemId' },
  ad_unit:    { collection: 'adUnits',    idField: 'adUnitId' },
  placement:  { collection: 'placements', idField: 'placementId' },
  custom_targeting_key: { collection: 'customTargetingKeys', idField: 'customTargetingKeyId' },
};

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

// Wrap a fetch impl with exponential-backoff retries on transient failures.
// 4xx (other than 429) are application errors — surface immediately. 429
// (quota) and 5xx (server) are retried with jitter. Network errors (thrown
// from fetch itself) are also retried.
export function withRetries(
  fetchImpl: typeof fetch,
  opts: { maxAttempts?: number; baseDelayMs?: number; logger?: Logger } = {},
): typeof fetch {
  const maxAttempts = opts.maxAttempts ?? 4; // 1 initial + 3 retries
  const baseDelay = opts.baseDelayMs ?? 250;
  const logger = opts.logger ?? noopLogger();
  return (async (input: any, init?: any) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetchImpl(input, init);
        if (res.status === 429 || res.status >= 500) {
          if (attempt === maxAttempts - 1) return res;
          const delay_ms = baseDelay * 2 ** attempt;
          logger.warn('gam.retry', { status: res.status, attempt: attempt + 1, max_attempts: maxAttempts, delay_ms });
          await sleepWithJitter(delay_ms);
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt === maxAttempts - 1) {
          logger.error('gam.fetch_failed', { message: e instanceof Error ? e.message : String(e), attempt: attempt + 1, max_attempts: maxAttempts });
          throw e;
        }
        const delay_ms = baseDelay * 2 ** attempt;
        logger.warn('gam.retry', { message: e instanceof Error ? e.message : String(e), attempt: attempt + 1, max_attempts: maxAttempts, delay_ms });
        await sleepWithJitter(delay_ms);
      }
    }
    throw lastErr ?? new Error('unreachable: retry loop exhausted');
  }) as typeof fetch;
}

function sleepWithJitter(ms: number): Promise<void> {
  // Add 0-25% jitter so concurrent retries don't synchronize.
  const jittered = ms * (1 + Math.random() * 0.25);
  return new Promise((r) => setTimeout(r, jittered));
}

function isoDate(d: Partial<GamDate> | undefined): string {
  if (!d?.year || !d.month || !d.day) return '';
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
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
    async listEntities({ entity_type, query, ids, limit, match }) {
      const meta = ENTITY_PATH[entity_type];
      const targetLimit = limit ?? 200;
      const matchMode: 'substring' | 'exact' = match ?? 'substring';

      // Map one raw GAM resource → Entity. Pulled out so both the list
      // pagination path and the by-id direct-GET path can share it.
      const toEntity = (e: any): Entity => {
        const explicitId = e[meta.idField];
        const resourceName = String(e.name ?? '');
        const id = explicitId !== undefined && explicitId !== null
          ? Number(explicitId)
          : Number(resourceName.split('/').pop());
        const gamDisplayName = typeof e.displayName === 'string' ? e.displayName : undefined;
        let primaryName: string;
        if (entity_type === 'custom_targeting_key') {
          // Prefer adTagName (canonical API code that appears in
          // KEY_VALUES_NAME). Fall back to displayName, then resource path
          // tail.
          const adTagName = typeof e.adTagName === 'string' ? e.adTagName : undefined;
          primaryName = adTagName ?? gamDisplayName ?? resourceName.split('/').pop() ?? '';
        } else {
          primaryName = gamDisplayName ?? resourceName;
        }
        const entity: Entity = { id, name: primaryName };
        if (gamDisplayName !== undefined && gamDisplayName !== primaryName) {
          entity.displayName = gamDisplayName;
        }
        return entity;
      };

      // ---- by-id path ----
      // Every by-id lookup goes through a direct GET. GAM refuses to filter a
      // list on the numeric id field for most resources ("Field lineItemId is
      // not supported for filtering" — measured for lineItems, adUnits,
      // placements and customTargetingKeys), and the ones that do accept it
      // are not worth a second code path: per-id GETs are cheap (parallel,
      // typically a handful of ids) and guarantee we never construct a filter
      // GAM will refuse to parse.
      if (ids?.length) {
        const results = await Promise.all(ids.slice(0, targetLimit).map(async (id) => {
          const url = `${networkPath}/${meta.collection}/${id}`;
          const res = await fetchImpl(url);
          if (res.status === 404) return null;
          if (!res.ok) throw new Error(`listEntities(getById) ${res.status}: ${await res.text()}`);
          const json = await res.json() as Record<string, unknown>;
          return toEntity(json);
        }));
        return results.filter((e): e is Entity => e !== null);
      }

      // ---- query/list path ----
      // GAM list filters follow AIP-160 (`field:"value"` is the has-operator,
      // `field = "value"` is equality). For custom_targeting_key, the `:`
      // has-operator on displayName is sometimes accepted but the API code
      // lives on the `name` attribute and is queryable with `=`. We try
      // substring first when the caller asked for it, and on a parse-error
      // fall back to exact on `name` so the request still succeeds.
      const filterForMode = (mode: 'substring' | 'exact', q: string): string => {
        if (mode === 'exact') {
          return entity_type === 'custom_targeting_key'
            ? `name = ${JSON.stringify(q)}`
            : `displayName = ${JSON.stringify(q)}`;
        }
        return `displayName:${JSON.stringify(q)}`;
      };

      const fetchPage = async (mode: 'substring' | 'exact', pageToken: string | undefined, pageSize: number) => {
        const params = new URLSearchParams();
        params.set('pageSize', String(pageSize));
        if (pageToken) params.set('pageToken', pageToken);
        if (query) params.set('filter', filterForMode(mode, query));
        const url = `${networkPath}/${meta.collection}?${params}`;
        const res = await fetchImpl(url);
        return res;
      };

      const out: Entity[] = [];
      let pageToken: string | undefined;
      let effectiveMode = matchMode;
      do {
        const remaining = targetLimit - out.length;
        const pageSize = Math.min(remaining, 200);
        let res = await fetchPage(effectiveMode, pageToken, pageSize);
        // Auto-fallback at the REST level: if a substring query against
        // custom_targeting_key trips GAM's filter parser, retry the same
        // page with exact-equality on `name`. Confined to this resource
        // type — other resources accept the substring shape.
        if (
          !res.ok
          && res.status === 400
          && effectiveMode === 'substring'
          && query
          && entity_type === 'custom_targeting_key'
        ) {
          effectiveMode = 'exact';
          res = await fetchPage(effectiveMode, pageToken, pageSize);
        }
        if (!res.ok) throw new Error(`listEntities ${res.status}: ${await res.text()}`);
        const json = await res.json() as Record<string, unknown>;
        const list = (json[meta.collection] as any[] | undefined) ?? [];
        for (const e of list) out.push(toEntity(e));
        pageToken = (json.nextPageToken as string | undefined) || undefined;
      } while (pageToken && out.length < targetLimit);
      return out.slice(0, targetLimit);
    },

    async getResource(path: string): Promise<Record<string, unknown> | null> {
      // GAM resource names are absolute ('networks/{code}/adUnits/1') inside
      // nested objects but callers often hold only the network-relative tail.
      const url = path.startsWith('networks/') ? `${BASE}/${path}` : `${networkPath}/${path}`;
      const res = await fetchImpl(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getResource ${res.status}: ${await res.text()}`);
      return await res.json() as Record<string, unknown>;
    },

    async createReport(query: ReportQuery, dateRange: DateRange): Promise<ReportOperation> {
      // Step 1: create the report resource
      const body = { reportDefinition: reportDefinition(query, dateRange) };
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
      return { state: 'done', download_url: resultPath, result: resultPath };
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

    async defineReport(query: ReportQuery, dateRange: DateRange) {
      const res = await fetchImpl(`${networkPath}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reportDefinition: reportDefinition(query, dateRange) }),
      });
      if (!res.ok) throw new Error(`defineReport ${res.status}: ${await res.text()}`);
      const report = await res.json() as { name: string };
      return { report: report.name };
    },

    async runReport(report: string) {
      const res = await fetchImpl(`${BASE}/${report}:run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`runReport ${res.status}: ${await res.text()}`);
      const op = await res.json() as { name: string };
      return { operation: op.name };
    },

    async fetchRows(result: string, page: { pageSize: number; pageToken?: string }) {
      const params = new URLSearchParams({ pageSize: String(page.pageSize) });
      if (page.pageToken) params.set('pageToken', page.pageToken);
      const res = await fetchImpl(`${BASE}/${result}:fetchRows?${params}`);
      if (res.status === 404) throw new ResultUnavailableError(result, 404);
      if (!res.ok) throw new Error(`fetchRows ${res.status}: ${await res.text()}`);
      const body = await res.json() as {
        rows?: ReportRow[];
        nextPageToken?: string;
        totalRowCount?: number | string;
        runTime?: string;
        dateRanges?: { startDate?: GamDate; endDate?: GamDate }[];
      };
      return {
        rows: body.rows ?? [],
        ...(body.nextPageToken && { nextPageToken: body.nextPageToken }),
        ...(body.totalRowCount !== undefined && { totalRowCount: Number(body.totalRowCount) }),
        ...(body.runTime && { runTime: body.runTime }),
        ...(body.dateRanges && {
          dateRanges: body.dateRanges.map((r) => ({ start: isoDate(r.startDate), end: isoDate(r.endDate) })),
        }),
      };
    },

    async getReport(report: string) {
      const res = await fetchImpl(`${BASE}/${report}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getReport ${res.status}: ${await res.text()}`);
      const r = await res.json() as { name: string; reportDefinition: ReportDefinition };
      return { name: r.name, definition: r.reportDefinition };
    },
  };
}
