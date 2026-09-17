import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_MAX_ENTRIES, PENDING_TTL_MS, createReportCache } from '../src/cache.js';
import { createLogger } from '../src/log.js';

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const T0 = Date.parse('2026-09-17T04:00:00Z');
const DONE = {
  report: 'networks/1234/reports/1',
  result: 'networks/1234/reports/1/results/1',
  run_time: '2026-09-17T03:59:00Z',
  date_range: { start: '2026-09-01', end: '2026-09-02' },
  total_row_count: 12,
};
const PENDING = { report: 'networks/1234/reports/1', operation: 'networks/1234/operations/reports/runs/1' };
const DONE_KEYS = ['kind', 'report', 'result', 'run_time', 'date_range', 'total_row_count', 'stored_at'];

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gam-cache-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('result cache (spec §2.5)', () => {
  it('E1: stores a result reference and never rows', () => {
    const c = createReportCache({ now: clock().now });
    c.putDone(KEY, DONE);
    const entry = c.get(KEY);
    expect(entry).toEqual({ kind: 'done', ...DONE, stored_at: '2026-09-17T04:00:00.000Z' });
    expect(Object.keys(entry!)).toEqual(DONE_KEYS);
  });

  it('counts a done entry as a hit and anything else as a miss', () => {
    const c = createReportCache();
    expect(c.stats()).toEqual({ hits: 0, misses: 0 });
    c.get(KEY);
    c.putDone(KEY, DONE);
    c.get(KEY);
    c.putPending(OTHER, PENDING);
    c.get(OTHER);
    expect(c.stats()).toEqual({ hits: 1, misses: 2 });
  });

  it('E3: a done entry lives for the TTL and no longer', () => {
    const t = clock();
    const c = createReportCache({ ttlMs: 60_000, now: t.now });
    c.putDone(KEY, DONE);
    t.advance(59_999);
    expect(c.get(KEY)?.kind).toBe('done');
    t.advance(1);
    expect(c.get(KEY)).toBeUndefined();
    expect(c.size()).toBe(0);
  });

  it('E3: a TTL of 0 keeps no done entry and drops a pending one for the same key', () => {
    const c = createReportCache({ ttlMs: 0 });
    c.putDone(KEY, DONE);
    expect(c.get(KEY)).toBeUndefined();
    c.putPending(KEY, PENDING);
    expect(c.get(KEY)?.kind).toBe('pending');
    c.putDone(KEY, DONE);
    expect(c.get(KEY)).toBeUndefined();
  });

  it('keeps a pending entry for one hour, whatever the TTL', () => {
    const t = clock();
    const c = createReportCache({ ttlMs: 1, now: t.now });
    c.putPending(KEY, PENDING);
    t.advance(PENDING_TTL_MS - 1);
    expect(c.get(KEY)).toEqual({ kind: 'pending', ...PENDING, started_at: '2026-09-17T04:00:00.000Z' });
    t.advance(1);
    expect(c.get(KEY)).toBeUndefined();
  });

  it('a pending entry stores the start time it is given', () => {
    const t = clock();
    const c = createReportCache({ now: t.now });
    c.putPending(KEY, PENDING);
    t.advance(10_000);
    c.putPending(KEY, { ...PENDING, started_at: '2026-09-17T04:00:00.000Z' });
    expect(c.get(KEY)).toMatchObject({ started_at: '2026-09-17T04:00:00.000Z' });
  });

  it('E4: holds 1,000 entries and drops the least recently used', () => {
    expect(CACHE_MAX_ENTRIES).toBe(1000);
    const c = createReportCache();
    for (let i = 0; i < CACHE_MAX_ENTRIES; i++) c.putDone(`k${i}`, DONE);
    expect(c.get('k0')?.kind).toBe('done'); // k0 becomes the most recently used
    c.putDone('k1000', DONE); // the 1,001st entry
    expect(c.size()).toBe(CACHE_MAX_ENTRIES);
    expect(c.get('k1')).toBeUndefined();
    expect(c.get('k0')?.kind).toBe('done');
    expect(c.get('k1000')?.kind).toBe('done');
  });

  it('deletes', () => {
    const c = createReportCache();
    c.putDone(KEY, DONE);
    c.delete(KEY);
    expect(c.get(KEY)).toBeUndefined();
  });

  it('deletes with a result only an entry that still names it or the operation that produced it', () => {
    const c = createReportCache();
    c.putDone(KEY, DONE);
    c.delete(KEY, { result: 'networks/1234/reports/1/results/9' });
    expect(c.get(KEY)).toMatchObject({ kind: 'done', result: DONE.result });
    c.delete(KEY, { result: DONE.result });
    expect(c.get(KEY)).toBeUndefined();

    c.putPending(KEY, PENDING);
    // A result with no known operation says nothing about a pending run.
    c.delete(KEY, { result: DONE.result });
    c.delete(KEY, { result: DONE.result, operation: 'networks/1234/operations/reports/runs/9' });
    expect(c.get(KEY)).toMatchObject({ kind: 'pending', operation: PENDING.operation });
    c.delete(KEY, { result: DONE.result, operation: PENDING.operation });
    expect(c.get(KEY)).toBeUndefined();
  });
});

describe('result cache disk tier (E6)', () => {
  it('stores references on disk that a fresh instance serves', () => withDir((dir) => {
    createReportCache({ diskDir: dir }).putDone(KEY, DONE);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, `${KEY}.json`), 'utf8')))).toEqual(DONE_KEYS);
    const fresh = createReportCache({ diskDir: dir });
    expect(fresh.get(KEY)).toMatchObject({ kind: 'done', ...DONE });
    expect(fresh.stats().hits).toBe(1);
  }));

  it('applies the TTL to entries on disk and removes expired files', () => withDir((dir) => {
    const t = clock();
    createReportCache({ diskDir: dir, ttlMs: 50, now: t.now }).putDone(KEY, DONE);
    t.advance(50);
    expect(createReportCache({ diskDir: dir, ttlMs: 50, now: t.now }).get(KEY)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  }));

  it('stores pending runs on disk too, and deletes from disk', () => withDir((dir) => {
    const c = createReportCache({ diskDir: dir });
    c.putPending(KEY, PENDING);
    expect(createReportCache({ diskDir: dir }).get(KEY)?.kind).toBe('pending');
    c.delete(KEY);
    expect(existsSync(join(dir, `${KEY}.json`))).toBe(false);
  }));

  it('checks an entry only on disk before a conditional delete', () => withDir((dir) => {
    createReportCache({ diskDir: dir }).putDone(KEY, DONE);
    const fresh = createReportCache({ diskDir: dir });
    fresh.delete(KEY, { result: 'networks/1234/reports/1/results/9' });
    expect(existsSync(join(dir, `${KEY}.json`))).toBe(true);
    fresh.delete(KEY, { result: DONE.result });
    expect(existsSync(join(dir, `${KEY}.json`))).toBe(false);
  }));

  it('treats an unreadable or foreign file as a miss and says so', () => withDir((dir) => {
    writeFileSync(join(dir, `${KEY}.json`), '{"rows":[{"REVENUE":1}]}');
    writeFileSync(join(dir, `${OTHER}.json`), 'not json');
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', sink: (l) => { lines.push(l); } });
    const c = createReportCache({ diskDir: dir, logger });
    expect(c.get(KEY)).toBeUndefined();
    expect(c.get(OTHER)).toBeUndefined();
    expect(lines.filter((l) => l.includes('"msg":"cache.disk_entry_invalid"'))).toHaveLength(2);
  }));

  it('creates the cache directory if it does not exist', () => withDir((parent) => {
    const dir = join(parent, 'nested', 'cache');
    createReportCache({ diskDir: dir });
    expect(existsSync(dir)).toBe(true);
  }));
});
