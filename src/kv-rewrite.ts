import type { GAMClient, ReportQuery } from './gam-client.js';
import { incompatibleWith } from './schema.js';

// Pure helpers for translating KEY_VALUES_* filters into the
// CUSTOM_DIMENSION_<N>_VALUE shape GAM actually accepts alongside request-time
// metrics (AD_REQUESTS, AdX/AdSense metrics, etc.). Pulled out of run_report
// so kv_report can share the resolution path.

// Recognized KV filter sources. KEY_VALUES_ID is an int64; we'd need a value
// catalog to translate, so we only rewrite the name-shaped form here.
const KV_FILTER_FIELDS = new Set(['KEY_VALUES_NAME']);

// Parses `channel_id=479` → { key: 'channel_id', value: '479' }. Trims
// whitespace and rejects strings without an `=` since CUSTOM_DIMENSION needs
// both halves.
export function parseKvPair(s: string): { key: string; value: string } | null {
  const idx = s.indexOf('=');
  if (idx <= 0 || idx === s.length - 1) return null;
  const key = s.slice(0, idx).trim();
  const value = s.slice(idx + 1).trim();
  if (!key || !value) return null;
  return { key, value };
}

// True iff the requested filter field is one of the KV sources we know how
// to rewrite and the metric set is incompatible with it per the curated
// matrix. Conservative on purpose: we only rewrite when GAM is going to
// reject the original query anyway.
export function isKvFilterIncompatibleWithMetrics(
  filterField: string,
  metrics: string[],
): boolean {
  if (!KV_FILTER_FIELDS.has(filterField)) return false;
  const bad = new Set(incompatibleWith(filterField));
  return metrics.some((m) => bad.has(m));
}

export type KvResolver = (keyName: string) => Promise<number | null>;

// Resolves a custom_targeting_key by API name (the adTagName, e.g.
// "channel_id") to its numeric ID via the configured GAMClient. Returns null
// when no key matches — caller is responsible for surfacing that as a
// user-facing error.
export function makeKvResolver(client: GAMClient): KvResolver {
  return async (keyName: string) => {
    const matches = await client.listEntities({
      entity_type: 'custom_targeting_key',
      query: keyName,
      match: 'exact',
      limit: 5,
    });
    const hit = matches.find((m) => m.name === keyName);
    return hit?.id ?? matches[0]?.id ?? null;
  };
}

// Picks the next free CUSTOM_DIMENSION slot (0..9). Returns -1 if all ten
// slots are taken — GAM caps the array at the number of dimension slots, so
// we can't allocate beyond that. Callers should surface this as an error.
export function nextFreeSlot(existing: number[] | undefined): number {
  const used = existing ?? [];
  for (let i = 0; i < 10; i++) {
    if (used[i] === undefined) return i;
  }
  return -1;
}

export type RewriteResult =
  | { rewritten: false }
  | { rewritten: true; query: ReportQuery; warning: string }
  | { rewritten: false; error: string };

// Examines a ReportQuery and, if it carries an incompatible
// KEY_VALUES_NAME=<key>=<value> filter, rewrites it to a CUSTOM_DIMENSION
// slot. Returns a new ReportQuery (does not mutate input) plus a
// human-readable warning the caller should attach to the envelope. If the
// rewrite can't proceed (unresolvable key, malformed value, no free slot),
// surfaces a structured error string so the caller can return INVALID_INPUT
// rather than blindly forwarding a query GAM will reject.
export async function maybeRewriteKvFilter(
  query: ReportQuery,
  resolve: KvResolver,
): Promise<RewriteResult> {
  if (!query.filters?.length) return { rewritten: false };
  // Locate the first KV filter that conflicts with metrics. Multiple KV
  // filters in one query is rare and unsupported here — rewriting all of
  // them would require careful slot bookkeeping the LLM rarely needs.
  let conflictIdx = -1;
  for (let i = 0; i < query.filters.length; i++) {
    const f = query.filters[i];
    if (isKvFilterIncompatibleWithMetrics(f.field, query.metrics)) {
      conflictIdx = i;
      break;
    }
  }
  if (conflictIdx === -1) return { rewritten: false };

  const filter = query.filters[conflictIdx];
  // Only single-value rewrites are supported; arrays would map to OR of
  // multiple slot filters, which GAM doesn't allow on a single slot.
  if (Array.isArray(filter.value)) {
    return {
      rewritten: false,
      error: `KEY_VALUES_NAME filter with array value cannot be auto-rewritten to CUSTOM_DIMENSION (single value required)`,
    };
  }
  const raw = String(filter.value);
  const parsed = parseKvPair(raw);
  if (!parsed) {
    return {
      rewritten: false,
      error: `KEY_VALUES_NAME filter value must be 'key=value' to auto-rewrite (got ${JSON.stringify(raw)})`,
    };
  }

  const keyId = await resolve(parsed.key);
  if (!keyId) {
    return {
      rewritten: false,
      error: `Unknown custom_targeting_key '${parsed.key}' — discover via lookup(entity_type="custom_targeting_key", match="exact").`,
    };
  }

  const slot = nextFreeSlot(query.custom_dimension_key_ids);
  if (slot === -1) {
    return {
      rewritten: false,
      error: `All 10 CUSTOM_DIMENSION slots already in use; cannot auto-rewrite KEY_VALUES_NAME`,
    };
  }

  const slotDim = `CUSTOM_DIMENSION_${slot}_VALUE`;
  const newKeyIds = [...(query.custom_dimension_key_ids ?? [])];
  while (newKeyIds.length < slot) newKeyIds.push(0); // pad if caller skipped slots
  newKeyIds[slot] = keyId;

  const newFilters = query.filters.slice();
  newFilters[conflictIdx] = { field: slotDim, op: '=', value: parsed.value };

  return {
    rewritten: true,
    query: {
      ...query,
      filters: newFilters,
      custom_dimension_key_ids: newKeyIds,
    },
    warning:
      `Auto-rewrote KEY_VALUES_NAME='${parsed.key}=${parsed.value}' to ` +
      `${slotDim}='${parsed.value}' (custom_dimension_key_ids[${slot}]=${keyId}, resolved from '${parsed.key}'). ` +
      `KEY_VALUES_NAME is incompatible with the requested metrics; CUSTOM_DIMENSION aggregates cleanly (one value per request).`,
  };
}
