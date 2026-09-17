import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DateSpan } from './envelope.js';
import type { Logger } from './log.js';
import { noopLogger } from './log.js';
import { Lru } from './lru.js';

// Which GAM result answers a definition — never the rows (spec §2.5).
export type DoneEntry = {
  kind: 'done';
  report: string;
  result: string;
  run_time: string | null;
  date_range: DateSpan | null;
  total_row_count: number | null;
  stored_at: string;
};

// A run that outlived its caller's timeout. The next identical call waits for
// this operation instead of starting another (spec §2.6).
export type PendingEntry = {
  kind: 'pending';
  report: string;
  operation: string;
  started_at: string;
};

export type CacheEntry = DoneEntry | PendingEntry;

export type ReportCache = {
  // The live entry for a key (a definition hash). A done entry counts as a
  // hit; no entry, or a pending one, counts as a miss.
  get(key: string): CacheEntry | undefined;
  putDone(key: string, entry: Omit<DoneEntry, 'kind' | 'stored_at'>): void;
  // A pending run recorded again keeps its original started_at.
  putPending(key: string, entry: { report: string; operation: string; started_at?: string }): void;
  delete(key: string): void;
  size(): number;
  // Session hit and miss counts, for usage_stats.
  stats(): { hits: number; misses: number };
};

export const CACHE_MAX_ENTRIES = 1000;
export const PENDING_TTL_MS = 3_600_000;
const DEFAULT_TTL_MS = 3_600_000;

function isSpan(v: unknown): v is DateSpan {
  return typeof v === 'object' && v !== null
    && typeof (v as DateSpan).start === 'string' && typeof (v as DateSpan).end === 'string';
}

// An entry read from disk, or undefined if the file holds anything else.
function parseEntry(v: unknown): CacheEntry | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const e = v as Record<string, unknown>;
  if (e.kind === 'pending'
    && typeof e.report === 'string' && typeof e.operation === 'string' && typeof e.started_at === 'string') {
    return { kind: 'pending', report: e.report as string, operation: e.operation as string, started_at: e.started_at as string };
  }
  if (e.kind === 'done'
    && typeof e.report === 'string' && typeof e.result === 'string' && typeof e.stored_at === 'string'
    && (e.run_time === null || typeof e.run_time === 'string')
    && (e.date_range === null || isSpan(e.date_range))
    && (e.total_row_count === null || (Number.isSafeInteger(e.total_row_count) && (e.total_row_count as number) >= 0))) {
    return {
      kind: 'done',
      report: e.report as string,
      result: e.result as string,
      run_time: e.run_time as string | null,
      date_range: e.date_range === null ? null : { start: (e.date_range as DateSpan).start, end: (e.date_range as DateSpan).end },
      total_row_count: e.total_row_count as number | null,
      stored_at: e.stored_at as string,
    };
  }
  return undefined;
}

export function createReportCache(opts: {
  // GAM_REPORT_CACHE_TTL_MS: how long a done entry is used; 0 keeps none.
  ttlMs?: number;
  // GAM_REPORT_CACHE_DIR, already specific to one network (cacheDirFor).
  diskDir?: string;
  logger?: Logger;
  now?: () => number;
} = {}): ReportCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? noopLogger();
  const dir = opts.diskDir;
  const memory = new Lru<string, CacheEntry>(CACHE_MAX_ENTRIES);
  if (dir) mkdirSync(dir, { recursive: true });
  let hits = 0;
  let misses = 0;

  const short = (key: string) => key.slice(0, 16);
  const iso = (ms: number) => new Date(ms).toISOString();
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // An unreadable timestamp is not live.
  const live = (e: CacheEntry): boolean =>
    e.kind === 'done'
      ? now() - Date.parse(e.stored_at) < ttlMs
      : now() - Date.parse(e.started_at) < PENDING_TTL_MS;

  function readDisk(key: string): CacheEntry | undefined {
    if (!dir) return undefined;
    let text: string;
    try {
      text = readFileSync(join(dir, `${key}.json`), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('cache.disk_read_failed', { key: short(key), message: message(e) });
      }
      return undefined;
    }
    let entry: CacheEntry | undefined;
    try {
      entry = parseEntry(JSON.parse(text));
    } catch {
      entry = undefined;
    }
    if (!entry) logger.warn('cache.disk_entry_invalid', { key: short(key) });
    return entry;
  }

  // Written under a temporary name and renamed, so a reader never sees half a file.
  function writeDisk(key: string, entry: CacheEntry): void {
    if (!dir) return;
    const path = join(dir, `${key}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, path);
    } catch (e) {
      logger.warn('cache.disk_write_failed', { key: short(key), message: message(e) });
    }
  }

  function removeDisk(key: string): void {
    if (!dir) return;
    try {
      unlinkSync(join(dir, `${key}.json`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('cache.disk_delete_failed', { key: short(key), message: message(e) });
      }
    }
  }

  function put(key: string, entry: CacheEntry): void {
    memory.set(key, entry);
    writeDisk(key, entry);
  }

  function remove(key: string): void {
    memory.delete(key);
    removeDisk(key);
  }

  return {
    get(key) {
      let entry = memory.get(key);
      if (!entry) {
        entry = readDisk(key);
        if (entry) memory.set(key, entry);
      }
      if (entry && !live(entry)) {
        remove(key);
        entry = undefined;
      }
      if (entry?.kind === 'done') {
        hits += 1;
        logger.debug('cache.hit', { key: short(key) });
      } else {
        misses += 1;
        logger.debug('cache.miss', { key: short(key), pending: entry !== undefined });
      }
      return entry;
    },
    putDone(key, e) {
      if (ttlMs === 0) {
        remove(key);
        return;
      }
      put(key, {
        kind: 'done',
        report: e.report,
        result: e.result,
        run_time: e.run_time,
        date_range: e.date_range,
        total_row_count: e.total_row_count,
        stored_at: iso(now()),
      });
    },
    putPending(key, e) {
      put(key, { kind: 'pending', report: e.report, operation: e.operation, started_at: e.started_at ?? iso(now()) });
    },
    delete: remove,
    size: () => memory.size,
    stats: () => ({ hits, misses }),
  };
}
