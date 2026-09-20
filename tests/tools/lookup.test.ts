import { describe, it, expect } from 'vitest';
import { lookupTool } from '../../src/tools/lookup.js';
import { makeCtx } from '../helpers.js';

describe('lookup', () => {
  it('returns matches by name substring', async () => {
    const ctx = makeCtx({
      entities: {
        advertiser: [
          { id: 1, name: 'Acme Corp' },
          { id: 2, name: 'Acme Industries' },
          { id: 3, name: 'Beta Inc' },
        ],
      },
    });
    const args = lookupTool.input.parse({ entity_type: 'advertiser', query: 'acme' });
    const r = await lookupTool.handler(args, ctx);
    expect('rows' in r).toBe(true);
    if ('rows' in r) {
      expect(r.rows).toEqual([
        { id: '1', name: 'Acme Corp', displayName: 'Acme Corp' },
        { id: '2', name: 'Acme Industries', displayName: 'Acme Industries' },
      ]);
    }
  });

  it('returns ENTITY_NOT_FOUND on no match', async () => {
    const ctx = makeCtx({
      entities: {
        advertiser: [
          { id: 1, name: 'Acme Corp' },
          { id: 2, name: 'Acme Industries' },
          { id: 3, name: 'Beta Inc' },
        ],
      },
    });
    const args = lookupTool.input.parse({ entity_type: 'advertiser', query: 'zzznope' });
    const r = await lookupTool.handler(args, ctx);
    expect('error' in r).toBe(true);
    if ('error' in r) expect((r.error as { code: string }).code).toBe('ENTITY_NOT_FOUND');
  });

  it('lists all (up to limit) when neither query nor ids is provided', async () => {
    const ctx = makeCtx({
      entities: {
        advertiser: [
          { id: 1, name: 'Acme Corp' },
          { id: 2, name: 'Acme Industries' },
          { id: 3, name: 'Beta Inc' },
        ],
      },
    });
    const args = lookupTool.input.parse({ entity_type: 'advertiser' });
    const r = await lookupTool.handler(args, ctx);
    expect('rows' in r).toBe(true);
    if ('rows' in r) {
      expect(r.rows).toEqual([
        { id: '1', name: 'Acme Corp', displayName: 'Acme Corp' },
        { id: '2', name: 'Acme Industries', displayName: 'Acme Industries' },
        { id: '3', name: 'Beta Inc', displayName: 'Beta Inc' },
      ]);
    }
  });

  it('surfaces both name (API code) and displayName for custom_targeting_key', async () => {
    const ctx = makeCtx({
      entities: {
        custom_targeting_key: [
          { id: 111, name: 'channel_id',  displayName: 'Channel ID' },
          { id: 222, name: 'tier',        displayName: 'Tier' },
          { id: 333, name: 'section',     displayName: 'Section' },
        ],
      },
    });
    const args = lookupTool.input.parse({
      entity_type: 'custom_targeting_key',
      query: 'channel_id',
      match: 'exact',
    });
    const r = await lookupTool.handler(args, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows).toEqual([
      { id: '111', name: 'channel_id', displayName: 'Channel ID' },
    ]);
  });

  it('auto-falls-back from substring to exact when GAM rejects the filter for custom_targeting_key', async () => {
    // The fake client throws a GAM-shaped 400 on the first (substring) call
    // and only honors the retry with match='exact'.
    let calls = 0;
    let lastMatch: string | undefined;
    const ctx = makeCtx({}, {
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
    });
    const args = lookupTool.input.parse({
      entity_type: 'custom_targeting_key',
      query: 'channel_id',
    });
    const r = await lookupTool.handler(args, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(calls).toBe(2);
    expect(lastMatch).toBe('exact');
    expect(r.rows).toEqual([
      { id: '111', name: 'channel_id', displayName: 'Channel ID' },
    ]);
  });
});
