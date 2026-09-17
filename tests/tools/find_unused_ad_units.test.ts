import { describe, it, expect } from 'vitest';
import { findUnusedAdUnitsTool } from '../../src/tools/find_unused_ad_units.js';
import { makeCtx } from '../helpers.js';

describe('find_unused_ad_units', () => {
  it('flags ad units that did not appear in the report', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      entities: {
        ad_unit: [
          { id: 1, name: 'Active' },
          { id: 2, name: 'Codeless_A' },
          { id: 3, name: 'Codeless_B' },
        ],
      },
      reports: [{
        query: {
          dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
          metrics: ['AD_REQUESTS'],
        },
        rows: [{ AD_UNIT_ID: 1, AD_UNIT_NAME: 'Active', AD_REQUESTS: 50000 }],
      }],
    }, { timezone: 'UTC', now });
    const r = await findUnusedAdUnitsTool.handler(findUnusedAdUnitsTool.input.parse({}), ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.rows!.map((x) => x.AD_UNIT_NAME).sort()).toEqual(['Codeless_A', 'Codeless_B']);
    expect(r.rows!.every((x) => x.ad_requests === '0')).toBe(true);
  });

  it('treats ad units below min_requests as unused', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      entities: {
        ad_unit: [
          { id: 1, name: 'Healthy' },
          { id: 2, name: 'BarelyUsed' },
          { id: 3, name: 'Dead' },
        ],
      },
      reports: [{
        query: {
          dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
          metrics: ['AD_REQUESTS'],
        },
        rows: [
          { AD_UNIT_ID: 1, AD_UNIT_NAME: 'Healthy', AD_REQUESTS: 50000 },
          { AD_UNIT_ID: 2, AD_UNIT_NAME: 'BarelyUsed', AD_REQUESTS: 500 }, // < 1000 threshold → unused
        ],
      }],
    }, { timezone: 'UTC', now });
    const r = await findUnusedAdUnitsTool.handler(
      findUnusedAdUnitsTool.input.parse({ min_requests: 1000 }),
      ctx,
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.rows!.map((x) => x.AD_UNIT_NAME)).toEqual(['Dead', 'BarelyUsed']);
  });

  it('names the report input in provenance (listEntities is not a report)', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      entities: { ad_unit: [{ id: 1, name: 'Active' }] },
      reports: [{
        query: {
          dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
          metrics: ['AD_REQUESTS'],
        },
        rows: [{ AD_UNIT_ID: 1, AD_UNIT_NAME: 'Active', AD_REQUESTS: 50000 }],
      }],
    }, { timezone: 'UTC', now });
    const r = await findUnusedAdUnitsTool.handler(findUnusedAdUnitsTool.input.parse({}), ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const inputs = (r as { provenance: { inputs: unknown[] } }).provenance.inputs;
    expect(inputs).toHaveLength(1);
  });
});
