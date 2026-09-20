import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveQueryTool,
  listSavedQueriesTool,
  runSavedQueryTool,
  deleteSavedQueryTool,
} from '../../src/tools/saved_queries.js';
import { createSavedQueryStore } from '../../src/saved-queries.js';
import { makeCtx } from '../helpers.js';

describe('saved_queries tools', () => {
  it('save_query persists and rejects duplicate names without replace=true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqt-'));
    const savedQueries = createSavedQueryStore(join(dir, 'q.json'));
    const ctx = makeCtx({}, { savedQueries });
    const args = saveQueryTool.input.parse({
      name: 'wow_revenue',
      dimensions: ['DATE'],
      metrics: ['REVENUE'],
      description: 'WoW revenue trend',
    });
    const first = await saveQueryTool.handler(args, ctx);
    expect('rows' in first).toBe(true);
    const dup = await saveQueryTool.handler(args, ctx);
    expect('error' in dup).toBe(true);
    const replaced = await saveQueryTool.handler({ ...args, replace: true }, ctx);
    expect('rows' in replaced).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('save_query accepts the CREATIVE_SIZE alias in dimensions and a same-named filter, stores it canonicalized, and warns (only disclosure point in the lifecycle)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqt-'));
    const savedQueries = createSavedQueryStore(join(dir, 'q.json'));
    const ctx = makeCtx({}, { savedQueries });
    const args = saveQueryTool.input.parse({
      name: 'by_creative_size',
      dimensions: ['CREATIVE_SIZE'],
      metrics: ['IMPRESSIONS'],
      filters: [{ field: 'CREATIVE_SIZE', op: '=', value: '300x250' }],
    });
    const r = await saveQueryTool.handler(args, ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const entry = savedQueries.get('by_creative_size');
    expect(entry?.body.dimensions).toEqual(['RENDERED_CREATIVE_SIZE']);
    expect(entry?.body.filters).toEqual([{ field: 'RENDERED_CREATIVE_SIZE', op: '=', value: '300x250' }]);
    // Two rewrites (the dimension and the filter field), each naming both the
    // given and the canonical spelling -- the only place this rewrite is ever
    // disclosed, since a replayed template is already canonical and
    // run_report's own re-resolution of it is a silent no-op.
    expect(r.warnings).toHaveLength(2);
    for (const w of r.warnings) expect(w).toMatch(/CREATIVE_SIZE.*RENDERED_CREATIVE_SIZE/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('list_saved_queries returns saved entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqt-'));
    const savedQueries = createSavedQueryStore(join(dir, 'q.json'));
    const ctx = makeCtx({}, { savedQueries });
    await saveQueryTool.handler(
      saveQueryTool.input.parse({ name: 'a', dimensions: ['DATE'], metrics: ['REVENUE'] }),
      ctx,
    );
    const r = await listSavedQueriesTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows.map((x) => x.name)).toEqual(['a']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('run_saved_query replays against a fresh date_range via run_report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqt-'));
    const savedQueries = createSavedQueryStore(join(dir, 'q.json'));
    const ctx = makeCtx(
      { reports: [{
        query: { dimensions: ['DATE'], metrics: ['REVENUE'] },
        rows: [{ DATE: '2026-04-01', REVENUE: 123 }],
      }] },
      { timezone: 'UTC', savedQueries },
    );
    await saveQueryTool.handler(
      saveQueryTool.input.parse({ name: 'rev', dimensions: ['DATE'], metrics: ['REVENUE'] }),
      ctx,
    );
    const r = await runSavedQueryTool.handler(
      runSavedQueryTool.input.parse({ name: 'rev', date_range: { start: '2026-04-01', end: '2026-04-01' } }),
      ctx,
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('run_saved_query returns ENTITY_NOT_FOUND for unknown name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqt-'));
    const savedQueries = createSavedQueryStore(join(dir, 'q.json'));
    const ctx = makeCtx({}, { timezone: 'UTC', savedQueries });
    const r = await runSavedQueryTool.handler(
      { name: 'nope', date_range: { start: '2026-04-01', end: '2026-04-01' } },
      ctx,
    );
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect((r.error as { code: string }).code).toBe('ENTITY_NOT_FOUND');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('delete_saved_query removes the entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqt-'));
    const savedQueries = createSavedQueryStore(join(dir, 'q.json'));
    const ctx = makeCtx({}, { savedQueries });
    await saveQueryTool.handler(
      saveQueryTool.input.parse({ name: 'x', dimensions: ['DATE'], metrics: ['REVENUE'] }),
      ctx,
    );
    const r = await deleteSavedQueryTool.handler({ name: 'x' }, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows[0].removed).toBe('true');
    const list = await listSavedQueriesTool.handler({}, ctx);
    if (!('rows' in list)) throw new Error(JSON.stringify(list));
    expect(list.rows).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
