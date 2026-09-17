import { describe, it, expect } from 'vitest';
import { describeSchemaTool } from '../../src/tools/describe_schema.js';
import { makeCtx } from '../helpers.js';

const run = async (args: unknown) => {
  const r = await describeSchemaTool.handler(describeSchemaTool.input.parse(args), makeCtx());
  if ('error' in r) throw new Error(JSON.stringify(r));
  return r;
};

describe('describe_schema', () => {
  it('returns both kinds on an unfiltered call, names only', async () => {
    const r = await run({});
    const kinds = new Set(r.rows.map((row) => row.kind));
    // Regression: dimensions outnumber metrics, so a single shared limit
    // would fill the page with dimensions and hide metrics entirely.
    expect(kinds.has('dimension')).toBe(true);
    expect(kinds.has('metric')).toBe(true);
    expect(r.rows[0]).not.toHaveProperty('description');
    expect(r.summary).toContain('names only');
  });

  it('turns on descriptions and the incompatibility matrix when filtered', async () => {
    const r = await run({ search: 'key_values' });
    const kvn = r.rows.find((row) => row.name === 'KEY_VALUES_NAME');
    expect(kvn?.incompatible_with).toContain('AD_REQUESTS');
    // Curated prose survives regeneration — this warning is not in the proto.
    expect(kvn?.description).toContain('NOT mutually exclusive');
  });

  it('keeps the matrix symmetric so either side surfaces the conflict', async () => {
    const r = await run({ family: 'AD_REQUESTS', include_descriptions: true });
    const adRequests = r.rows.find((row) => row.name === 'AD_REQUESTS');
    expect(adRequests?.incompatible_with).toContain('KEY_VALUES_NAME');
  });

  it('filters to one report type and reports what the type accepts', async () => {
    const r = await run({ report_type: 'reach', kind: 'metric' });
    const names = r.rows.map((row) => row.name);
    expect(names).toContain('UNIQUE_VISITORS');
    expect(names).toContain('REACH_IMPRESSIONS');
    // IMPRESSIONS is HISTORICAL-only, so it must not appear under REACH.
    expect(names).not.toContain('IMPRESSIONS');
    expect(r.summary).toContain('report_type=REACH');
  });

  it('flags report types this server forwards but has not verified', async () => {
    // REAL_TIME_VIDEO has no purpose-built tool, so run_report forwards it
    // blind. AD_SPEED etc. are no longer in this category — they have tools.
    const r = await run({ report_type: 'REAL_TIME_VIDEO', kind: 'metric' });
    expect(r.summary).toContain('unverified');
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('does not flag report types that have a purpose-built tool', async () => {
    const r = await run({ report_type: 'AD_SPEED', kind: 'metric' });
    expect(r.summary).not.toContain('unverified');
  });

  it('rejects an unknown report type with the valid list', async () => {
    const r = await run({ report_type: 'NOT_A_TYPE' });
    expect(r.total_row_count).toBe(0);
    expect(r.summary).toContain('HISTORICAL');
  });

  it('announces truncation instead of implying it returned everything', async () => {
    const r = await run({ kind: 'metric', limit: 5, include_descriptions: false });
    expect(r.total_row_count).toBe(5);
    expect(r.summary).toContain('truncated');
  });
});
