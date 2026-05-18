import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSavedQueryStore, defaultSavedQueriesPath } from '../src/saved-queries.js';

describe('saved-queries store', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sq-'));
    path = join(dir, 'q.json');
  });

  it('save then get round-trips a query body', () => {
    const s = createSavedQueryStore(path);
    s.save('weekly', { dimensions: ['DATE'], metrics: ['REVENUE'] }, 'WoW revenue');
    const got = s.get('weekly');
    expect(got?.name).toBe('weekly');
    expect(got?.body.dimensions).toEqual(['DATE']);
    expect(got?.description).toBe('WoW revenue');
    expect(got?.saved_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('list returns entries sorted by name', () => {
    const s = createSavedQueryStore(path);
    s.save('zeta', { dimensions: ['DATE'], metrics: ['REVENUE'] });
    s.save('alpha', { dimensions: ['DATE'], metrics: ['REVENUE'] });
    expect(s.list().map((e) => e.name)).toEqual(['alpha', 'zeta']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('delete removes the entry; returns false for missing', () => {
    const s = createSavedQueryStore(path);
    s.save('q', { dimensions: ['DATE'], metrics: ['REVENUE'] });
    expect(s.delete('q')).toBe(true);
    expect(s.get('q')).toBeNull();
    expect(s.delete('q')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes atomically (no stray tmp file after success)', () => {
    const s = createSavedQueryStore(path);
    s.save('q', { dimensions: ['DATE'], metrics: ['REVENUE'] });
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('defaultSavedQueriesPath', () => {
  it('honors GAM_SAVED_QUERIES_FILE first', () => {
    expect(defaultSavedQueriesPath({ GAM_SAVED_QUERIES_FILE: '/tmp/custom.json' } as NodeJS.ProcessEnv))
      .toBe('/tmp/custom.json');
  });
  it('falls back to XDG_CONFIG_HOME', () => {
    expect(defaultSavedQueriesPath({ XDG_CONFIG_HOME: '/x' } as NodeJS.ProcessEnv))
      .toBe('/x/gam-mcp/saved-queries.json');
  });
});
