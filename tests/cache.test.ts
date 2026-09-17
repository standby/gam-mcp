import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

type Options = Omit<Parameters<typeof createReportCache>[0], 'networkCode'>;
const cache = (over: Options = {}) => createReportCache({ networkCode: '1234', ...over });

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

function recording() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ level: 'warn', sink: (l) => { lines.push(JSON.parse(l)); } });
  return { lines, logger, messages: () => lines.map((l) => l.msg) };
}

describe('result cache (spec §2.5)', () => {
  it('E1: stores a result reference and never rows', () => {
    const c = cache({ now: clock().now });
    c.putDone(KEY, DONE);
    const entry = c.get(KEY);
    expect(entry).toEqual({ kind: 'done', ...DONE, stored_at: '2026-09-17T04:00:00.000Z' });
    expect(Object.keys(entry!)).toEqual(DONE_KEYS);
  });

  it('counts a done entry as a hit and anything else as a miss', () => {
    const c = cache();
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
    const c = cache({ ttlMs: 60_000, now: t.now });
    c.putDone(KEY, DONE);
    t.advance(59_999);
    expect(c.get(KEY)?.kind).toBe('done');
    t.advance(1);
    expect(c.get(KEY)).toBeUndefined();
    expect(c.size()).toBe(0);
  });

  it('E3: a TTL of 0 keeps no done entry and drops a pending one for the same key', () => {
    const c = cache({ ttlMs: 0 });
    c.putDone(KEY, DONE);
    expect(c.get(KEY)).toBeUndefined();
    c.putPending(KEY, PENDING);
    expect(c.get(KEY)?.kind).toBe('pending');
    c.putDone(KEY, DONE);
    expect(c.get(KEY)).toBeUndefined();
  });

  it('keeps a pending entry for one hour, whatever the TTL', () => {
    const t = clock();
    const c = cache({ ttlMs: 1, now: t.now });
    c.putPending(KEY, PENDING);
    t.advance(PENDING_TTL_MS - 1);
    expect(c.get(KEY)).toEqual({ kind: 'pending', ...PENDING, started_at: '2026-09-17T04:00:00.000Z' });
    t.advance(1);
    expect(c.get(KEY)).toBeUndefined();
  });

  it('a pending entry stores the start time it is given', () => {
    const t = clock();
    const c = cache({ now: t.now });
    c.putPending(KEY, PENDING);
    t.advance(10_000);
    c.putPending(KEY, { ...PENDING, started_at: '2026-09-17T04:00:00.000Z' });
    expect(c.get(KEY)).toMatchObject({ started_at: '2026-09-17T04:00:00.000Z' });
  });

  it('E4: holds 1,000 entries and drops the least recently used', () => {
    const key = (i: number) => i.toString(16).padStart(64, '0');
    expect(CACHE_MAX_ENTRIES).toBe(1000);
    const c = cache();
    for (let i = 0; i < CACHE_MAX_ENTRIES; i++) c.putDone(key(i), DONE);
    expect(c.get(key(0))?.kind).toBe('done'); // entry 0 becomes the most recently used
    c.putDone(key(1000), DONE); // the 1,001st entry
    expect(c.size()).toBe(CACHE_MAX_ENTRIES);
    expect(c.get(key(1))).toBeUndefined();
    expect(c.get(key(0))?.kind).toBe('done');
    expect(c.get(key(1000))?.kind).toBe('done');
  });

  it('deletes', () => {
    const c = cache();
    c.putDone(KEY, DONE);
    c.delete(KEY);
    expect(c.get(KEY)).toBeUndefined();
  });

  it('deletes with a result only an entry that still names it or the operation that produced it', () => {
    const c = cache();
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

  // Only definitionHash produces keys, and a key becomes a file name.
  it.each([
    ['a short key', 'k1'],
    ['upper-case hex', 'A'.repeat(64)],
    ['a path', `../${'a'.repeat(61)}`],
    ['a longer key', 'a'.repeat(65)],
  ])('refuses %s', (_, key) => {
    const c = cache();
    expect(() => c.get(key)).toThrow(/definition hash/);
    expect(() => c.putDone(key, DONE)).toThrow(/definition hash/);
    expect(() => c.putPending(key, PENDING)).toThrow(/definition hash/);
    expect(() => c.delete(key)).toThrow(/definition hash/);
  });

  it('refuses a network code that is not digits', () => {
    expect(() => createReportCache({ networkCode: '12.4' })).toThrow(/network code/);
  });
});

// Names an entry must not carry, for network 1234. The first two are the
// traversal a prefix check would let through.
const BAD_NAMES: [string, Record<string, string>][] = [
  ['a result that climbs out of its network', {
    kind: 'done', report: DONE.report, result: 'networks/1234/%2e%2e/%2e%2e/networks/5678/reports/2/results/3',
  }],
  ['a report that climbs out of its network', {
    kind: 'done',
    report: 'networks/1234/%2e%2e/%2e%2e/networks/5678/reports/2',
    result: 'networks/1234/%2e%2e/%2e%2e/networks/5678/reports/2/results/3',
  }],
  ["another network's report", { kind: 'done', report: 'networks/5678/reports/1', result: 'networks/5678/reports/1/results/1' }],
  ["another report's result", { kind: 'done', report: DONE.report, result: 'networks/1234/reports/2/results/1' }],
  ['a result with more after it', { kind: 'done', report: DONE.report, result: `${DONE.result}/x` }],
  ['a result with a line break after it', { kind: 'done', report: DONE.report, result: `${DONE.result}\n` }],
  ["another network's operation", { kind: 'pending', report: PENDING.report, operation: 'networks/5678/operations/reports/runs/1' }],
  ['an operation that climbs out of its network', {
    kind: 'pending', report: PENDING.report, operation: 'networks/1234/%2e%2e/networks/5678/operations/reports/runs/1',
  }],
];

// Times an entry must not carry while the clock reads T0.
const BAD_TIMES: [string, Record<string, string>][] = [
  ['a stored time in the future', { kind: 'done', stored_at: '2026-09-17T04:00:00.001Z' }],
  ['a start time in the future', { kind: 'pending', started_at: '2026-09-17T05:00:00.000Z' }],
  ['a stored time that is not a time', { kind: 'done', stored_at: 'yesterday' }],
  ['a start time that is not a time', { kind: 'pending', started_at: '' }],
];

// A whole entry as this server writes it, with `over` applied.
function onDisk(over: Record<string, string>): Record<string, unknown> {
  const base = over.kind === 'pending'
    ? { kind: 'pending', ...PENDING, started_at: '2026-09-17T03:30:00.000Z' }
    : { kind: 'done', ...DONE, stored_at: '2026-09-17T03:30:00.000Z' };
  return { ...base, ...over };
}

describe('result cache entries belong to this network (spec §2.5)', () => {
  it.each([['done'], ['pending']])('serves a %s entry from disk that this network wrote', (kind) => withDir((dir) => {
    writeFileSync(join(dir, `${KEY}.json`), JSON.stringify(onDisk({ kind })));
    expect(cache({ diskDir: dir, now: clock().now }).get(KEY)).toEqual(onDisk({ kind }));
  }));

  it.each([...BAD_NAMES, ...BAD_TIMES])('treats a disk entry with %s as a miss and says so', (_, over) => withDir((dir) => {
    writeFileSync(join(dir, `${KEY}.json`), JSON.stringify(onDisk(over)));
    const { messages, logger } = recording();
    expect(cache({ diskDir: dir, logger, now: clock().now }).get(KEY)).toBeUndefined();
    expect(messages()).toEqual(['cache.disk_entry_invalid']);
  }));

  it.each(BAD_NAMES)('does not keep an entry with %s, in memory or on disk', (_, e) => withDir((dir) => {
    const { messages, logger } = recording();
    const c = cache({ diskDir: dir, logger });
    if (e.kind === 'done') c.putDone(KEY, { ...DONE, report: e.report, result: e.result });
    else c.putPending(KEY, { report: e.report, operation: e.operation });
    expect(c.get(KEY)).toBeUndefined();
    expect(messages()).toEqual(['cache.entry_rejected']);
    expect(readdirSync(dir)).toEqual([]);
  }));

  it('does not keep a pending entry whose given start is in the future', () => {
    const { messages, logger } = recording();
    const c = cache({ logger, now: clock().now });
    c.putPending(KEY, { ...PENDING, started_at: '2026-09-17T05:00:00.000Z' });
    expect(c.get(KEY)).toBeUndefined();
    expect(messages()).toEqual(['cache.entry_rejected']);
  });
});

describe('result cache disk tier (E6)', () => {
  it('stores references on disk that a fresh instance serves', () => withDir((dir) => {
    cache({ diskDir: dir }).putDone(KEY, DONE);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, `${KEY}.json`), 'utf8')))).toEqual(DONE_KEYS);
    const fresh = cache({ diskDir: dir });
    expect(fresh.get(KEY)).toMatchObject({ kind: 'done', ...DONE });
    expect(fresh.stats().hits).toBe(1);
  }));

  it('applies the TTL to entries on disk and removes expired files', () => withDir((dir) => {
    const t = clock();
    cache({ diskDir: dir, ttlMs: 50, now: t.now }).putDone(KEY, DONE);
    t.advance(50);
    expect(cache({ diskDir: dir, ttlMs: 50, now: t.now }).get(KEY)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  }));

  it('stores pending runs on disk too, and deletes from disk', () => withDir((dir) => {
    const c = cache({ diskDir: dir });
    c.putPending(KEY, PENDING);
    expect(cache({ diskDir: dir }).get(KEY)?.kind).toBe('pending');
    c.delete(KEY);
    expect(existsSync(join(dir, `${KEY}.json`))).toBe(false);
  }));

  it('checks an entry only on disk before a conditional delete', () => withDir((dir) => {
    cache({ diskDir: dir }).putDone(KEY, DONE);
    const fresh = cache({ diskDir: dir });
    fresh.delete(KEY, { result: 'networks/1234/reports/1/results/9' });
    expect(existsSync(join(dir, `${KEY}.json`))).toBe(true);
    fresh.delete(KEY, { result: DONE.result });
    expect(existsSync(join(dir, `${KEY}.json`))).toBe(false);
  }));

  it('treats an unreadable or foreign file as a miss and says so', () => withDir((dir) => {
    writeFileSync(join(dir, `${KEY}.json`), '{"rows":[{"REVENUE":1}]}');
    writeFileSync(join(dir, `${OTHER}.json`), 'not json');
    const { messages, logger } = recording();
    const c = cache({ diskDir: dir, logger });
    expect(c.get(KEY)).toBeUndefined();
    expect(c.get(OTHER)).toBeUndefined();
    expect(messages()).toEqual(['cache.disk_entry_invalid', 'cache.disk_entry_invalid']);
  }));

  it('creates the cache directory, readable by its owner only, if it does not exist', () => withDir((parent) => {
    const dir = join(parent, 'nested', 'cache');
    cache({ diskDir: dir });
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }));

  it('logs a failed write, keeps serving from memory and leaves no temporary file', () => withDir((dir) => {
    // A directory where the entry's file should go makes the final rename fail
    // after the temporary file has been written.
    mkdirSync(join(dir, `${KEY}.json`));
    const { lines, logger } = recording();
    const c = cache({ diskDir: dir, logger });
    c.putDone(KEY, DONE);
    expect(lines).toEqual([expect.objectContaining({ level: 'warn', msg: 'cache.disk_write_failed', key: KEY.slice(0, 16) })]);
    expect(c.get(KEY)).toMatchObject({ kind: 'done', ...DONE });
    expect(readdirSync(dir)).toEqual([`${KEY}.json`]);
  }));
});
