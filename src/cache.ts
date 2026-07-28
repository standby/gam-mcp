import type { ReportQuery, DateRange } from './gam-client.js';
import type { Logger } from './log.js';
import { noopLogger } from './log.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export type CachedRows = Record<string, string>[];

export type ReportCache = {
  get(query: ReportQuery, dateRange: DateRange): CachedRows | undefined;
  set(query: ReportQuery, dateRange: DateRange, rows: CachedRows): void;
  size(): number;
  // Session-scoped hit/miss counters. Useful for the usage_stats tool;
  // not used internally for any decision.
  stats(): { hits: number; misses: number };
};

// In-process Map keyed by canonicalized query+date_range. Lifetime is the
// MCP server process — perfect for stdio sessions where the LLM iterates
// on adjacent questions and revisits the same time slice multiple times.
// No TTL (queries reflect a closed past period; results don't change), no
// LRU eviction (sessions are short-lived).
export function createReportCache(
  opts: { logger?: Logger; diskDir?: string; ttlMs?: number } = {},
): ReportCache {
  const store = new Map<string, CachedRows>();
  const logger = opts.logger ?? noopLogger();
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000; // 1 hour default
  const diskDir = opts.diskDir;
  if (diskDir && !existsSync(diskDir)) {
    mkdirSync(diskDir, { recursive: true });
  }
  let hits = 0;
  let misses = 0;
  return {
    get(query, dateRange) {
      const key = keyFor(query, dateRange);
      const mem = store.get(key);
      if (mem) {
        hits += 1;
        logger.debug('cache.hit', { key_hash: shortHash(key), tier: 'memory' });
        return mem;
      }
      if (diskDir) {
        const disk = readFromDisk(diskDir, key, ttlMs, logger);
        if (disk) {
          // Warm the memory tier so subsequent lookups in this session skip
          // the fs+gunzip+parse cost. Disk hits count as cache hits.
          store.set(key, disk);
          hits += 1;
          logger.debug('cache.hit', { key_hash: shortHash(key), tier: 'disk' });
          return disk;
        }
      }
      misses += 1;
      logger.debug('cache.miss', { key_hash: shortHash(key) });
      return undefined;
    },
    set(query, dateRange, rows) {
      const key = keyFor(query, dateRange);
      store.set(key, rows);
      if (diskDir) {
        try {
          writeToDisk(diskDir, key, rows);
        } catch (e) {
          // Disk persistence is best-effort. A full disk or permission error
          // should never crash the tool — the in-memory tier still serves.
          logger.warn('cache.disk_write_failed', { key_hash: shortHash(key), message: e instanceof Error ? e.message : String(e) });
        }
      }
    },
    size() { return store.size; },
    stats() { return { hits, misses }; },
  };
}

function diskPath(dir: string, key: string): string {
  // Filename = sha256 of the canonical key, in a flat dir. Avoids deep
  // nesting and any platform path-length surprises with long key strings.
  return join(dir, `${createHash('sha256').update(key).digest('hex')}.json.gz`);
}

function readFromDisk(
  dir: string,
  key: string,
  ttlMs: number,
  logger: Logger,
): CachedRows | undefined {
  const path = diskPath(dir, key);
  if (!existsSync(path)) return undefined;
  try {
    const ageMs = Date.now() - statSync(path).mtimeMs;
    if (ageMs > ttlMs) {
      // Opportunistic cleanup of stale entries.
      try { unlinkSync(path); } catch { /* ignore */ }
      return undefined;
    }
    const buf = readFileSync(path);
    const json = gunzipSync(buf).toString('utf8');
    return JSON.parse(json) as CachedRows;
  } catch (e) {
    logger.warn('cache.disk_read_failed', { message: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

function writeToDisk(dir: string, key: string, rows: CachedRows): void {
  const path = diskPath(dir, key);
  const buf = gzipSync(Buffer.from(JSON.stringify(rows)));
  // No atomic rename here — single-process MCP server, the race window for
  // duplicate writes is microscopic and a half-written file is detected
  // by JSON.parse failing at read time (logged + treated as miss).
  writeFileSync(path, buf);
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function keyFor(q: ReportQuery, dr: DateRange): string {
  // Sort dims/metrics so callers don't have to. Filters are pre-sorted by
  // (field, op) with their values stringified. custom_dimension_key_ids
  // are positional, so order matters — preserve as-is.
  // ponytail: report_type is intentionally absent — it's a pure function of
  // the metric list (resolveReportType), so metrics already disambiguate it.
  const dims = [...q.dimensions].sort();
  const metrics = [...q.metrics].sort();
  const filters = (q.filters ?? [])
    .map((f) => ({
      field: f.field,
      op: f.op,
      value: Array.isArray(f.value) ? [...f.value].map(String).sort() : String(f.value),
    }))
    .sort((a, b) => a.field.localeCompare(b.field) || a.op.localeCompare(b.op));
  return JSON.stringify({
    dims,
    metrics,
    filters,
    cdki: q.custom_dimension_key_ids ?? [],
    dr,
  });
}
