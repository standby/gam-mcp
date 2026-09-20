import { describe, it, expect } from 'vitest';
import { viewabilityBreakdownTool } from '../../src/tools/viewability_breakdown.js';
import { makeCtx } from '../helpers.js';

const METRICS = [
  'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
  'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
  'ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
  'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
  'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE',
];

describe('viewability_breakdown', () => {
  it('returns viewability metrics by creative size', async () => {
    const args = viewabilityBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'size',
    });
    const r = await viewabilityBreakdownTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: { dimensions: ['RENDERED_CREATIVE_SIZE'], metrics: METRICS },
          rows: [{
            RENDERED_CREATIVE_SIZE: '300x250',
            ACTIVE_VIEW_VIEWABLE_IMPRESSIONS: 700000,
            ACTIVE_VIEW_MEASURABLE_IMPRESSIONS: 1000000,
            ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS: 1100000,
            ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: 0.7,
            ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE: 0.91,
          }],
        }] },
        { timezone: 'UTC' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
  });

  it('does not emit a duplicate dimension when by and group_by collide', async () => {
    const args = viewabilityBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'device',
      group_by: 'device',
    });
    // Single DEVICE_CATEGORY_NAME dimension — the collision guard drops the duplicate.
    const r = await viewabilityBreakdownTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: { dimensions: ['DEVICE_CATEGORY_NAME'], metrics: METRICS },
          rows: [{
            DEVICE_CATEGORY_NAME: 'DESKTOP',
            ACTIVE_VIEW_VIEWABLE_IMPRESSIONS: 500000,
            ACTIVE_VIEW_MEASURABLE_IMPRESSIONS: 600000,
            ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS: 650000,
            ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: 0.83,
            ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE: 0.92,
          }],
        }] },
        { timezone: 'UTC' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
  });
});
