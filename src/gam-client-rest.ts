import type {
  GAMClient,
  EntityType,
  OperationStatus,
  Entity,
  StoredReport,
} from './gam-client.js';
import { GamHttpError, ReportFilterRejectedError, ResultUnavailableError } from './gam-client.js';
import type { Logger } from './log.js';
import { noopLogger } from './log.js';
import type { ReportRow } from './values.js';
import { isoDate, type GamDate, type ReportDefinition } from './report-definition.js';
import { definitionHash, reportName } from './report-key.js';

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

// Retries transient failures with exponential backoff (spec §2.3). A GET is
// retried on a thrown fetch, 429 and 5xx. A POST is retried only on 429, the
// one answer that means GAM did not act on it: after a 5xx or a lost
// connection the report may already exist, and the next identical call finds
// it by name instead of creating a second one. Other 4xx answers return at once.
export function withRetries(
  fetchImpl: typeof fetch,
  opts: { maxAttempts?: number; baseDelayMs?: number; logger?: Logger } = {},
): typeof fetch {
  const maxAttempts = opts.maxAttempts ?? 4; // 1 initial + 3 retries
  const baseDelay = opts.baseDelayMs ?? 250;
  const logger = opts.logger ?? noopLogger();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const post = method === 'POST';
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(input, init);
      } catch (e) {
        lastErr = e;
        const message = e instanceof Error ? e.message : String(e);
        if (post || attempt === maxAttempts - 1) {
          logger.error('gam.fetch_failed', { method, message, attempt: attempt + 1, max_attempts: maxAttempts });
          throw e;
        }
        const delay_ms = baseDelay * 2 ** attempt;
        logger.warn('gam.retry', { method, message, attempt: attempt + 1, max_attempts: maxAttempts, delay_ms });
        await sleepWithJitter(delay_ms);
        continue;
      }
      const retryable = res.status === 429 || (!post && res.status >= 500);
      if (!retryable || attempt === maxAttempts - 1) return res;
      const delay_ms = baseDelay * 2 ** attempt;
      logger.warn('gam.retry', { method, status: res.status, attempt: attempt + 1, max_attempts: maxAttempts, delay_ms });
      await sleepWithJitter(delay_ms);
    }
    throw lastErr ?? new Error('unreachable: retry loop exhausted');
  }) as typeof fetch;
}

function sleepWithJitter(ms: number): Promise<void> {
  // Add 0-25% jitter so concurrent retries don't synchronize.
  const jittered = ms * (1 + Math.random() * 0.25);
  return new Promise((r) => setTimeout(r, jittered));
}

// The error for a non-2xx answer, with GAM's canonical status when the body has one.
async function httpError(call: string, res: Response): Promise<GamHttpError> {
  const text = await res.text();
  let gamStatus: string | undefined;
  try {
    const status = (JSON.parse(text) as { error?: { status?: unknown } } | null)?.error?.status;
    if (typeof status === 'string') gamStatus = status;
  } catch {
    // Not JSON: the text itself is the detail.
  }
  return new GamHttpError(call, res.status, gamStatus, text.slice(0, 500));
}

// GAM reports a result it no longer serves as NOT_FOUND or FAILED_PRECONDITION
// naming that result (spec §1.3). The status alone could be about something else.
function namesResult(err: GamHttpError, result: string): boolean {
  if (err.gamStatus !== 'NOT_FOUND' && err.gamStatus !== 'FAILED_PRECONDITION') return false;
  if (err.detail.includes(result)) return true;
  const id = result.slice(result.lastIndexOf('/') + 1);
  return /^\d+$/.test(id) && new RegExp(`results/${id}(?!\\d)`).test(err.detail);
}

type RawReport = { name: string; displayName?: string; reportDefinition?: Partial<ReportDefinition> };

// GAM's JSON omits empty lists, so a stored definition can lack dimensions or
// metrics; the rest of the server relies on both being present.
function toStoredReport(r: RawReport): StoredReport {
  const d = r.reportDefinition ?? {};
  return {
    name: r.name,
    ...(r.displayName !== undefined && { displayName: r.displayName }),
    definition: { ...d, dimensions: d.dimensions ?? [], metrics: d.metrics ?? [] } as ReportDefinition,
  };
}

export function createRestGamClient(opts: {
  networkCode: string;
  fetchImpl?: typeof fetch;
}): GAMClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const networkPath = `${BASE}/networks/${opts.networkCode}`;

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

    async getNetwork() {
      const res = await fetchImpl(networkPath);
      if (!res.ok) throw await httpError('getNetwork', res);
      const n = await res.json() as { networkCode?: string; timeZone?: string; currencyCode?: string };
      if (!n.timeZone) throw new Error('getNetwork: GAM returned no timeZone');
      if (!n.currencyCode) throw new Error('getNetwork: GAM returned no currencyCode');
      return { networkCode: n.networkCode ?? opts.networkCode, timeZone: n.timeZone, currencyCode: n.currencyCode };
    },

    async pollOperation(operation_name: string): Promise<OperationStatus> {
      const res = await fetchImpl(`${BASE}/${operation_name}`);
      if (!res.ok) throw await httpError('pollOperation', res);
      const op = await res.json() as {
        done?: boolean;
        error?: { message: string };
        response?: { reportResult?: string };
      };
      if (!op.done) return { state: 'running' };
      if (op.error) return { state: 'failed', reason: op.error.message };
      const resultPath = op.response?.reportResult;
      if (!resultPath) return { state: 'failed', reason: 'response missing reportResult' };
      return { state: 'done', result: resultPath };
    },

    async defineReport(definition: ReportDefinition) {
      const res = await fetchImpl(`${networkPath}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Named from the definition's hash so any process can find it again
        // (spec §2.2). visibility stays unset: GAM's default, HIDDEN, keeps
        // these reports out of the Ad Manager UI.
        body: JSON.stringify({ displayName: reportName(definitionHash(definition)), reportDefinition: definition }),
      });
      if (!res.ok) throw await httpError('defineReport', res);
      const report = await res.json() as { name: string };
      return { report: report.name };
    },

    async runReport(report: string) {
      const res = await fetchImpl(`${BASE}/${report}:run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw await httpError('runReport', res);
      const op = await res.json() as { name: string };
      return { operation: op.name };
    },

    async fetchRows(result: string, page: { pageSize: number; pageToken?: string }) {
      const params = new URLSearchParams({ pageSize: String(page.pageSize) });
      if (page.pageToken) params.set('pageToken', page.pageToken);
      const res = await fetchImpl(`${BASE}/${result}:fetchRows?${params}`);
      if (res.status === 404) throw new ResultUnavailableError(result, 404);
      if (!res.ok) {
        const err = await httpError('fetchRows', res);
        throw namesResult(err, result) ? new ResultUnavailableError(result, res.status) : err;
      }
      const body = await res.json() as {
        rows?: ReportRow[];
        nextPageToken?: string;
        totalRowCount?: number | string;
        runTime?: string;
        dateRanges?: { startDate?: GamDate; endDate?: GamDate }[];
      };
      // A range with either end missing isn't a date range GAM reported — it's
      // absence, and absence must not be dressed up as '' so the "no date
      // range" warning gets skipped downstream. Drop such entries; only keep
      // dateRanges at all if something usable survives.
      const dateRanges = (body.dateRanges ?? [])
        .map((r) => ({ start: isoDate(r.startDate), end: isoDate(r.endDate) }))
        .filter((r): r is { start: string; end: string } => r.start !== undefined && r.end !== undefined);
      return {
        rows: body.rows ?? [],
        ...(body.nextPageToken && { nextPageToken: body.nextPageToken }),
        ...(body.totalRowCount !== undefined && { totalRowCount: Number(body.totalRowCount) }),
        ...(body.runTime && { runTime: body.runTime }),
        ...(dateRanges.length > 0 && { dateRanges }),
      };
    },

    async getReport(report: string) {
      const res = await fetchImpl(`${BASE}/${report}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await httpError('getReport', res);
      return toStoredReport(await res.json() as RawReport);
    },

    async listReports({ displayName }: { displayName: string }) {
      const out: StoredReport[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ filter: `displayName = ${JSON.stringify(displayName)}`, pageSize: '100' });
        if (pageToken) params.set('pageToken', pageToken);
        const res = await fetchImpl(`${networkPath}/reports?${params}`);
        if (res.status === 400) throw new ReportFilterRejectedError(res.status);
        if (!res.ok) throw await httpError('listReports', res);
        const body = await res.json() as { reports?: RawReport[]; nextPageToken?: string };
        out.push(...(body.reports ?? []).map(toStoredReport));
        pageToken = body.nextPageToken || undefined;
      } while (pageToken);
      return out;
    },
  };
}
