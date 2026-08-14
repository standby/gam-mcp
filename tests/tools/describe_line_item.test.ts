import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeLineItemTool } from '../../src/tools/describe_line_item.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

// Entirely synthetic network / keys / values — nothing here mirrors a real
// publisher's configuration.
const NET = 'networks/11111';
const keyPath = (id: number) => `${NET}/customTargetingKeys/${id}`;
const valPath = (id: number) => `${NET}/customTargetingValues/${id}`;

const literal = (key: number, values: number[], negative?: boolean) => ({
  customTargetingKey: keyPath(key),
  customTargetingValues: values.map(valPath),
  ...(negative ? { negative: true } : {}),
});

const RESOURCES: Record<string, Record<string, unknown>> = {
  // Two clauses (OR), the second negated (AND within a clause via 2 literals).
  'lineItems/1': {
    name: `${NET}/lineItems/1`,
    lineItemId: '1',
    displayName: 'Line Item One',
    status: 'DELIVERING',
    priority: 8,
    targeting: {
      inventoryTargeting: { targetedAdUnits: [{ adUnit: `${NET}/adUnits/700` }] },
      customTargeting: {
        customTargetingClauses: [
          { customTargetingLiterals: [literal(10, [101, 102])] },
          { customTargetingLiterals: [literal(10, [103]), literal(11, [104], true)] },
        ],
      },
    },
  },
  // No targeting at all.
  'lineItems/2': { name: `${NET}/lineItems/2`, lineItemId: '2', displayName: 'Line Item Two', status: 'PAUSED' },
  // References a value id that no longer resolves.
  'lineItems/3': {
    name: `${NET}/lineItems/3`,
    lineItemId: '3',
    displayName: 'Line Item Three',
    targeting: {
      customTargeting: {
        customTargetingClauses: [{ customTargetingLiterals: [literal(10, [101, 999])] }],
      },
    },
  },
  [keyPath(10)]: { name: keyPath(10), adTagName: 'key_a', displayName: 'Key A' },
  [keyPath(11)]: { name: keyPath(11), adTagName: 'key_b', displayName: 'Key B' },
  [valPath(101)]: { name: valPath(101), adTagName: 'val_1', displayName: 'Value One' },
  [valPath(102)]: { name: valPath(102), adTagName: 'val_2', displayName: 'Value Two' },
  [valPath(103)]: { name: valPath(103), adTagName: 'val_3', displayName: 'Value Three' },
  [valPath(104)]: { name: valPath(104), adTagName: 'val_4', displayName: 'Value Four' },
  [`${NET}/adUnits/700`]: { name: `${NET}/adUnits/700`, displayName: 'Ad Unit 700' },
};

const makeCtx = (client = createMockGamClient({ resources: RESOURCES })) => {
  const dir = mkdtempSync(join(tmpdir(), 'dli-'));
  return {
    dir,
    ctx: {
      client,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    },
  };
};

describe('describe_line_item', () => {
  it('flattens clauses, marks negation, and resolves paths to labels', async () => {
    const { ctx, dir } = makeCtx();
    const r = await describeLineItemTool.handler(describeLineItemTool.input.parse({ ids: [1] }), ctx) as any;
    expect(r.line_items).toHaveLength(1);
    const li = r.line_items[0];
    // Raw fields pass through untouched.
    expect(li.status).toBe('DELIVERING');
    expect(li.priority).toBe(8);
    expect(li.id).toBe(1);
    // Clause index preserved: clause 0 OR clause 1; clause 1 has two AND'd literals.
    expect(li.custom_targeting).toEqual([
      { clause: 0, key: 'key_a', key_id: '10', op: 'IS ANY OF', values: ['val_1', 'val_2'], value_ids: ['101', '102'] },
      { clause: 1, key: 'key_a', key_id: '10', op: 'IS ANY OF', values: ['val_3'], value_ids: ['103'] },
      { clause: 1, key: 'key_b', key_id: '11', op: 'IS NONE OF', values: ['val_4'], value_ids: ['104'] },
    ]);
    // Paths outside customTargeting are resolved too.
    expect(r.resolved_paths[`${NET}/adUnits/700`]).toEqual({ id: '700', name: 'Ad Unit 700' });
    expect(r.resolved_paths[keyPath(10)]).toEqual({ id: '10', name: 'key_a', displayName: 'Key A' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces literal fields it does not map, so a renamed negation flag cannot hide', async () => {
    const resources = {
      ...RESOURCES,
      'lineItems/4': {
        name: `${NET}/lineItems/4`,
        lineItemId: '4',
        targeting: {
          customTargeting: {
            customTargetingClauses: [{
              customTargetingLiterals: [{ ...literal(10, [101]), excluded: true }],
            }],
          },
        },
      },
    };
    const { ctx, dir } = makeCtx(createMockGamClient({ resources }));
    const r = await describeLineItemTool.handler(describeLineItemTool.input.parse({ ids: [4] }), ctx) as any;
    expect(r.line_items[0].custom_targeting[0].unrecognized_fields).toEqual({ excluded: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('omits unrecognized_fields when every literal field is mapped', async () => {
    const { ctx, dir } = makeCtx();
    const r = await describeLineItemTool.handler(describeLineItemTool.input.parse({ ids: [1] }), ctx) as any;
    expect(r.line_items[0].custom_targeting[0].unrecognized_fields).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('handles a line item with no targeting', async () => {
    const { ctx, dir } = makeCtx();
    const r = await describeLineItemTool.handler(describeLineItemTool.input.parse({ ids: [2] }), ctx) as any;
    expect(r.line_items[0].custom_targeting).toEqual([]);
    expect(r.resolved_paths).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });

  it('degrades to the raw path when a referenced resource cannot be resolved', async () => {
    const { ctx, dir } = makeCtx();
    const r = await describeLineItemTool.handler(describeLineItemTool.input.parse({ ids: [3] }), ctx) as any;
    expect(r.line_items[0].custom_targeting[0].values).toEqual(['val_1', valPath(999)]);
    expect(r.resolved_paths[valPath(999)]).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves each shared path exactly once across line items', async () => {
    const base = createMockGamClient({ resources: RESOURCES });
    const calls: string[] = [];
    const client = { ...base, getResource: async (p: string) => { calls.push(p); return base.getResource(p); } };
    const { ctx, dir } = makeCtx(client);
    await describeLineItemTool.handler(describeLineItemTool.input.parse({ ids: [1, 3] }), ctx);
    // key 10 and value 101 are referenced by both line items.
    expect(calls.filter((c) => c === keyPath(10))).toHaveLength(1);
    expect(calls.filter((c) => c === valPath(101))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('separates a fetch failure from an absent resource and warns about it', async () => {
    const base = createMockGamClient({ resources: RESOURCES });
    const client = {
      ...base,
      getResource: async (p: string) => {
        if (p === valPath(102)) throw new Error('getResource 429: rate limit');
        return base.getResource(p);
      },
    };
    const { ctx, dir } = makeCtx(client);
    const r = await describeLineItemTool.handler(describeLineItemTool.input.parse({ ids: [1] }), ctx) as any;
    // Degrades to the raw path rather than throwing...
    expect(r.line_items[0].custom_targeting[0].values).toEqual(['val_1', valPath(102)]);
    // ...but the caller can tell it was a failure, not a deleted value.
    expect(r.resolution.failed).toBe(1);
    expect(r.resolution.missing).toBe(0);
    expect(r.warnings[0]).toContain('could not be fetched');
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves in bounded batches rather than one unbounded burst', async () => {
    // 60 values across one clause: with RESOLVE_BATCH=20 no more than 20
    // requests may be in flight at once.
    const ids = Array.from({ length: 60 }, (_, i) => 200 + i);
    const resources: Record<string, Record<string, unknown>> = {
      'lineItems/9': {
        name: `${NET}/lineItems/9`,
        lineItemId: '9',
        targeting: { customTargeting: { customTargetingClauses: [{ customTargetingLiterals: [literal(10, ids)] }] } },
      },
      [keyPath(10)]: RESOURCES[keyPath(10)],
      ...Object.fromEntries(ids.map((i) => [valPath(i), { name: valPath(i), adTagName: `val_${i}` }])),
    };
    const base = createMockGamClient({ resources });
    let inFlight = 0;
    let peak = 0;
    const client = {
      ...base,
      getResource: async (p: string) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return base.getResource(p);
      },
    };
    const { ctx, dir } = makeCtx(client);
    const r = await describeLineItemTool.handler(describeLineItemTool.input.parse({ ids: [9] }), ctx) as any;
    expect(peak).toBeLessThanOrEqual(20);
    expect(r.resolution.resolved).toBe(61);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports ids that do not exist, and errors when none do', async () => {
    const { ctx, dir } = makeCtx();
    const partial = await describeLineItemTool.handler(
      describeLineItemTool.input.parse({ ids: [2, 404] }), ctx,
    ) as any;
    expect(partial.not_found).toEqual([404]);
    expect(partial.line_items).toHaveLength(1);

    const none = await describeLineItemTool.handler(
      describeLineItemTool.input.parse({ ids: [404] }), ctx,
    );
    expect('error' in none).toBe(true);
    if ('error' in none) expect((none.error as { code: string }).code).toBe('ENTITY_NOT_FOUND');
    rmSync(dir, { recursive: true, force: true });
  });
});
