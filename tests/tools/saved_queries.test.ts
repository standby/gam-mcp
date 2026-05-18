import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  saveQueryTool,
  listSavedQueriesTool,
  runSavedQueryTool,
  deleteSavedQueryTool,
} from '../../src/tools/saved_queries.js';
import { createSavedQueryStore } from '../../src/saved-queries.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'sqt-'));
  const savedQueries = createSavedQueryStore(join(dir, 'q.json'));
  return {
    dir,
    ctx: {
      client: createMockGamClient(),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
      savedQueries,
    },
  };
}

describe('saved_queries tools', () => {
  it('save_query persists and rejects duplicate names without replace=true', async () => {
    const { ctx, dir } = makeCtx();
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

  it('list_saved_queries returns saved entries', async () => {
    const { ctx, dir } = makeCtx();
    await saveQueryTool.handler(
      saveQueryTool.input.parse({ name: 'a', dimensions: ['DATE'], metrics: ['REVENUE'] }),
      ctx,
    );
    const r = await listSavedQueriesTool.handler({}, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows!.map((x) => x.name)).toEqual(['a']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('run_saved_query replays against a fresh date_range via run_report', async () => {
    const { ctx, dir } = makeCtx();
    // Replace mock client with one that has a matching report fixture.
    const csv = gzipSync(Buffer.from('date,revenue\n2026-04-01,123\n'));
    const ctxWithReport = {
      ...ctx,
      client: createMockGamClient({
        reports: [{
          query: { dimensions: ['DATE'], metrics: ['REVENUE'] },
          csvGz: csv,
        }],
      }),
    };
    await saveQueryTool.handler(
      saveQueryTool.input.parse({ name: 'rev', dimensions: ['DATE'], metrics: ['REVENUE'] }),
      ctxWithReport,
    );
    const r = await runSavedQueryTool.handler(
      runSavedQueryTool.input.parse({ name: 'rev', date_range: { start: '2026-04-01', end: '2026-04-01' } }),
      ctxWithReport,
    );
    if (!('row_count' in r)) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('run_saved_query returns ENTITY_NOT_FOUND for unknown name', async () => {
    const { ctx, dir } = makeCtx();
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
    const { ctx, dir } = makeCtx();
    await saveQueryTool.handler(
      saveQueryTool.input.parse({ name: 'x', dimensions: ['DATE'], metrics: ['REVENUE'] }),
      ctx,
    );
    const r = await deleteSavedQueryTool.handler({ name: 'x' }, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows![0].removed).toBe('true');
    const list = await listSavedQueriesTool.handler({}, ctx);
    if (!('rows' in list)) throw new Error(JSON.stringify(list));
    expect(list.rows).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
