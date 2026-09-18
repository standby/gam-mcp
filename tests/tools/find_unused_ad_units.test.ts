import { describe, it, expect } from 'vitest';
import { findUnusedAdUnitsTool } from '../../src/tools/find_unused_ad_units.js';
import { makeCtx } from '../helpers.js';

describe('find_unused_ad_units', () => {
  it('flags ad units that did not appear in the report', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      entities: {
        ad_unit: [
          { id: 1, name: 'Active', status: 'ACTIVE' },
          { id: 2, name: 'Codeless_A', status: 'ACTIVE' },
          { id: 3, name: 'Codeless_B', status: 'ACTIVE' },
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
          { id: 1, name: 'Healthy', status: 'ACTIVE' },
          { id: 2, name: 'BarelyUsed', status: 'ACTIVE' },
          { id: 3, name: 'Dead', status: 'ACTIVE' },
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

  it('warns when the ad-unit scan hit the max_units cap', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      entities: {
        ad_unit: [
          { id: 1, name: 'Active', status: 'ACTIVE' },
          { id: 2, name: 'Codeless', status: 'ACTIVE' },
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
    const r = await findUnusedAdUnitsTool.handler(
      findUnusedAdUnitsTool.input.parse({ max_units: 2 }),
      ctx,
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.warnings).toContain(
      'Only the first 2 ad units were checked; the network may have more. Raise max_units to check more. ' +
      'Leaf detection (no child ad units) only saw the listed units, so a unit that looks like a leaf here may have children outside the scan.',
    );
  });

  it('does not warn when fewer ad units exist than max_units', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      entities: { ad_unit: [{ id: 1, name: 'Active', status: 'ACTIVE' }] },
      reports: [{
        query: {
          dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
          metrics: ['AD_REQUESTS'],
        },
        rows: [{ AD_UNIT_ID: 1, AD_UNIT_NAME: 'Active', AD_REQUESTS: 50000 }],
      }],
    }, { timezone: 'UTC', now });
    const r = await findUnusedAdUnitsTool.handler(
      findUnusedAdUnitsTool.input.parse({ max_units: 2 }),
      ctx,
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.warnings.some((w) => w.includes('max_units'))).toBe(false);
  });

  it('names the report input in provenance (listEntities is not a report)', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      entities: { ad_unit: [{ id: 1, name: 'Active', status: 'ACTIVE' }] },
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

  it('I9: ignores inactive units, parent containers and units with no status, and states the rule', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      entities: {
        ad_unit: [
          { id: 1, name: 'Parent', status: 'ACTIVE' },
          { id: 2, name: 'Child', status: 'ACTIVE', parentAdUnit: 'networks/1234/adUnits/1' },
          { id: 3, name: 'Archived', status: 'ARCHIVED' },
          { id: 4, name: 'NoStatus' }, // no status field at all -- must not be treated as active
        ],
      },
      reports: [{
        query: {
          dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
          metrics: ['AD_REQUESTS'],
        },
        rows: [], // nothing served: every active leaf looks unused
      }],
    }, { timezone: 'UTC', now });
    const r = await findUnusedAdUnitsTool.handler(findUnusedAdUnitsTool.input.parse({}), ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    // Only unit 2 is active AND a leaf: 1 is a parent (named by 2's
    // parentAdUnit), 3 is archived, 4 has no status at all.
    expect(r.rows!.map((x) => x.AD_UNIT_NAME)).toEqual(['Child']);
    expect(r.warnings.join(' ')).toMatch(/active/i);
    expect(r.warnings.join(' ')).toMatch(/no child ad units/i);
    // §4.5's second sentence: absence from the report means zero, not unknown.
    expect(r.warnings.join(' ')).toMatch(/omits rows whose metrics are all zero/i);
  });

  it('summary states flagged, candidate, listed and excluded counts', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      entities: {
        ad_unit: [
          { id: 1, name: 'Parent', status: 'ACTIVE' },                                            // excluded: non-leaf
          { id: 2, name: 'Child', status: 'ACTIVE', parentAdUnit: 'networks/1234/adUnits/1' },     // candidate, flagged (no row)
          { id: 3, name: 'Healthy', status: 'ACTIVE' },                                            // candidate, not flagged (has requests)
          { id: 4, name: 'Archived', status: 'ARCHIVED' },                                         // excluded: not active
          { id: 5, name: 'NoStatus' },                                                             // excluded: no status field
        ],
      },
      reports: [{
        query: {
          dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
          metrics: ['AD_REQUESTS'],
        },
        rows: [{ AD_UNIT_ID: 3, AD_UNIT_NAME: 'Healthy', AD_REQUESTS: 50000 }],
      }],
    }, { timezone: 'UTC', now });
    const r = await findUnusedAdUnitsTool.handler(findUnusedAdUnitsTool.input.parse({}), ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    // 5 listed; candidates are Child and Healthy (2); Parent/Archived/NoStatus
    // excluded (3); only Child (no report row) is flagged (1).
    expect(r.rows!.map((x) => x.AD_UNIT_NAME)).toEqual(['Child']);
    expect(r.summary).toContain(
      '1 of 2 active, leaf ad units flagged (5 listed; 3 excluded as archived or non-leaf).',
    );
  });
});
