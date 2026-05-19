import { describe, it, expect } from 'vitest';
import { lookupTool } from '../../src/tools/lookup.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ctx = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lkp-'));
  return {
    dir,
    ctx: {
      client: createMockGamClient({
        entities: {
          advertiser: [
            { id: 1, name: 'Acme Corp' },
            { id: 2, name: 'Acme Industries' },
            { id: 3, name: 'Beta Inc' },
          ],
        },
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
    },
  };
};

describe('lookup', () => {
  it('returns matches by name substring', async () => {
    const { ctx: c, dir } = ctx();
    const args = lookupTool.input.parse({ entity_type: 'advertiser', query: 'acme' });
    const r = await lookupTool.handler(args, c);
    expect('rows' in r).toBe(true);
    if ('rows' in r) {
      expect(r.rows).toEqual([
        { id: '1', name: 'Acme Corp', displayName: 'Acme Corp' },
        { id: '2', name: 'Acme Industries', displayName: 'Acme Industries' },
      ]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns ENTITY_NOT_FOUND on no match', async () => {
    const { ctx: c, dir } = ctx();
    const args = lookupTool.input.parse({ entity_type: 'advertiser', query: 'zzznope' });
    const r = await lookupTool.handler(args, c);
    expect('error' in r).toBe(true);
    if ('error' in r) expect((r.error as { code: string }).code).toBe('ENTITY_NOT_FOUND');
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists all (up to limit) when neither query nor ids is provided', async () => {
    const { ctx: c, dir } = ctx();
    const args = lookupTool.input.parse({ entity_type: 'advertiser' });
    const r = await lookupTool.handler(args, c);
    expect('rows' in r).toBe(true);
    if ('rows' in r) {
      expect(r.rows).toEqual([
        { id: '1', name: 'Acme Corp', displayName: 'Acme Corp' },
        { id: '2', name: 'Acme Industries', displayName: 'Acme Industries' },
        { id: '3', name: 'Beta Inc', displayName: 'Beta Inc' },
      ]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces both name (API code) and displayName for custom_targeting_key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkp-'));
    const c = {
      client: createMockGamClient({
        entities: {
          custom_targeting_key: [
            { id: 111, name: 'channel_id',  displayName: 'Channel ID' },
            { id: 222, name: 'tier',        displayName: 'Tier' },
            { id: 333, name: 'section',     displayName: 'Section' },
          ],
        },
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
    };
    const args = lookupTool.input.parse({
      entity_type: 'custom_targeting_key',
      query: 'channel_id',
      match: 'exact',
    });
    const r = await lookupTool.handler(args, c);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows).toEqual([
      { id: '111', name: 'channel_id', displayName: 'Channel ID' },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto-falls-back from substring to exact when GAM rejects the filter for custom_targeting_key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkp-'));
    // The fake client throws a GAM-shaped 400 on the first (substring) call
    // and only honors the retry with match='exact'.
    let calls = 0;
    let lastMatch: string | undefined;
    const c = {
      client: {
        async listEntities(q: { match?: string }) {
          calls++;
          lastMatch = q.match;
          if (q.match !== 'exact') {
            throw new Error('listEntities 400: filter parse error');
          }
          return [{ id: 111, name: 'channel_id', displayName: 'Channel ID' }];
        },
      } as any,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
    };
    const args = lookupTool.input.parse({
      entity_type: 'custom_targeting_key',
      query: 'channel_id',
    });
    const r = await lookupTool.handler(args, c);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(calls).toBe(2);
    expect(lastMatch).toBe('exact');
    expect(r.rows).toEqual([
      { id: '111', name: 'channel_id', displayName: 'Channel ID' },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});
