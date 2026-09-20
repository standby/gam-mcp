import { describe, it, expect } from 'vitest';
import {
  parseKvPair,
  nextFreeSlot,
  maybeRewriteKvFilter,
  isKvFilterIncompatibleWithMetrics,
  makeKvResolver,
} from '../src/kv-rewrite.js';
import { createMockGamClient } from '../src/gam-client.js';

describe('kv-rewrite', () => {
  it('parseKvPair splits on the first =', () => {
    expect(parseKvPair('channel_id=479')).toEqual({ key: 'channel_id', value: '479' });
    // Multi-= values are preserved (rare but possible in raw KV strings).
    expect(parseKvPair('foo=bar=baz')).toEqual({ key: 'foo', value: 'bar=baz' });
  });

  it('parseKvPair rejects malformed inputs', () => {
    expect(parseKvPair('no_equals')).toBeNull();
    expect(parseKvPair('=missingkey')).toBeNull();
    expect(parseKvPair('missingvalue=')).toBeNull();
    expect(parseKvPair('')).toBeNull();
  });

  it('nextFreeSlot returns 0 for empty, next free index otherwise', () => {
    expect(nextFreeSlot(undefined)).toBe(0);
    expect(nextFreeSlot([])).toBe(0);
    expect(nextFreeSlot([100])).toBe(1);
    expect(nextFreeSlot([100, 200, 300])).toBe(3);
    expect(nextFreeSlot(Array.from({ length: 10 }, (_, i) => i + 1))).toBe(-1);
  });

  it('isKvFilterIncompatibleWithMetrics flags KEY_VALUES_NAME + AD_REQUESTS', () => {
    expect(isKvFilterIncompatibleWithMetrics('KEY_VALUES_NAME', ['AD_REQUESTS'])).toBe(true);
    expect(isKvFilterIncompatibleWithMetrics('KEY_VALUES_NAME', ['REVENUE'])).toBe(false);
    expect(isKvFilterIncompatibleWithMetrics('AD_UNIT_NAME', ['AD_REQUESTS'])).toBe(false);
  });

  it('maybeRewriteKvFilter rewrites a conflicting filter to CUSTOM_DIMENSION_0_VALUE', async () => {
    const resolver = async (k: string) => (k === 'channel_id' ? { id: 12345 } : null);
    const r = await maybeRewriteKvFilter(
      {
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'channel_id=479' }],
      },
      resolver,
    );
    if (!r.rewritten) throw new Error('expected rewrite');
    expect(r.query.filters).toEqual([
      { field: 'CUSTOM_DIMENSION_0_VALUE', op: '=', value: '479' },
    ]);
    expect(r.query.custom_dimension_key_ids).toEqual([12345]);
    expect(r.warning).toContain('channel_id');
    expect(r.warning).toContain('CUSTOM_DIMENSION_0_VALUE');
  });

  it('maybeRewriteKvFilter picks the next free slot when slot 0 is already used', async () => {
    const resolver = async () => ({ id: 999 });
    const r = await maybeRewriteKvFilter(
      {
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'tier=gold' }],
        custom_dimension_key_ids: [555],
      },
      resolver,
    );
    if (!r.rewritten) throw new Error('expected rewrite');
    // slot 0 is taken (555), so rewrite lands on slot 1.
    expect(r.query.custom_dimension_key_ids).toEqual([555, 999]);
    expect(r.query.filters).toEqual([
      { field: 'CUSTOM_DIMENSION_1_VALUE', op: '=', value: 'gold' },
    ]);
  });

  it('maybeRewriteKvFilter is a no-op when filters are compatible with metrics', async () => {
    const r = await maybeRewriteKvFilter(
      {
        dimensions: ['KEY_VALUES_NAME'],
        metrics: ['REVENUE', 'IMPRESSIONS'],
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'channel_id=479' }],
      },
      async () => ({ id: 12345 }),
    );
    expect(r.rewritten).toBe(false);
  });

  it('maybeRewriteKvFilter surfaces a structured error when the key is unknown', async () => {
    const r = await maybeRewriteKvFilter(
      {
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'mystery=999' }],
      },
      async () => null,
    );
    expect(r.rewritten).toBe(false);
    if ('error' in r) expect(r.error).toMatch(/Unknown custom_targeting_key 'mystery'/);
    else throw new Error('expected error');
  });

  it('maybeRewriteKvFilter rejects malformed key=value', async () => {
    const r = await maybeRewriteKvFilter(
      {
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'no_equals_sign' }],
      },
      async () => ({ id: 12345 }),
    );
    if (r.rewritten || !('error' in r)) throw new Error('expected error');
    expect(r.error).toMatch(/key=value/);
  });

  it('maybeRewriteKvFilter rejects array-valued KV filters (one slot can hold one value)', async () => {
    const r = await maybeRewriteKvFilter(
      {
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        filters: [{ field: 'KEY_VALUES_NAME', op: 'IN', value: ['channel_id=1', 'channel_id=2'] }],
      },
      async () => ({ id: 12345 }),
    );
    if (r.rewritten || !('error' in r)) throw new Error('expected error');
    expect(r.error).toMatch(/array/);
  });

  describe('a key name that matches more than one key (spec §3.3)', () => {
    const keys = [
      { id: 11, name: 'section', displayName: 'Section' },
      { id: 12, name: 'section', displayName: 'Section (old)' },
      { id: 13, name: 'topic' },
    ];
    const resolve = makeKvResolver(createMockGamClient({ entities: { custom_targeting_key: keys } }));

    it('makeKvResolver returns every candidate instead of the first', async () => {
      expect(await resolve('section')).toEqual({ ambiguous: [keys[0], keys[1]] });
      expect(await resolve('topic')).toEqual({ id: 13 });
      expect(await resolve('nothing')).toBeNull();
    });

    it('maybeRewriteKvFilter returns AMBIGUOUS_NAME with the candidates', async () => {
      const r = await maybeRewriteKvFilter(
        {
          dimensions: ['DATE'],
          metrics: ['AD_REQUESTS'],
          filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'section=news' }],
        },
        resolve,
      );
      if (r.rewritten || !('failure' in r)) throw new Error(`expected a failure, got ${JSON.stringify(r)}`);
      expect(r.failure.error).toMatchObject({
        code: 'AMBIGUOUS_NAME',
        message: 'Multiple custom_targeting_keys matched "section".',
        details: {
          entity_type: 'custom_targeting_key',
          query: 'section',
          candidates: [
            { id: 11, name: 'section', displayName: 'Section' },
            { id: 12, name: 'section', displayName: 'Section (old)' },
          ],
        },
      });
      expect(r.failure.error.hint).toContain('custom_dimension_key_ids');
    });
  });
});
