import { describe, it, expect } from 'vitest';
import { yieldBreakdownTool } from '../../src/tools/yield_breakdown.js';
import { makeCtx } from '../helpers.js';

const METRICS = [
  'YIELD_GROUP_IMPRESSIONS',
  'YIELD_GROUP_ESTIMATED_REVENUE',
  'YIELD_GROUP_ESTIMATED_CPM',
  'YIELD_GROUP_MEDIATION_FILL_RATE',
  'YIELD_GROUP_MEDIATION_PASSBACKS',
];

describe('yield_breakdown', () => {
  it('breaks down by Open Bidding partner with yield-group metrics', async () => {
    const args = yieldBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
    });
    const r = await yieldBreakdownTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: { dimensions: ['YIELD_GROUP_BUYER_NAME'], metrics: METRICS },
          rows: [
            {
              YIELD_GROUP_BUYER_NAME: 'PartnerA',
              YIELD_GROUP_IMPRESSIONS: 1000000,
              YIELD_GROUP_ESTIMATED_REVENUE: 1500,
              YIELD_GROUP_ESTIMATED_CPM: 1.5,
              YIELD_GROUP_MEDIATION_FILL_RATE: 0.62,
              YIELD_GROUP_MEDIATION_PASSBACKS: 40000,
            },
            {
              YIELD_GROUP_BUYER_NAME: 'PartnerB',
              YIELD_GROUP_IMPRESSIONS: 500000,
              YIELD_GROUP_ESTIMATED_REVENUE: 1000,
              YIELD_GROUP_ESTIMATED_CPM: 2.0,
              YIELD_GROUP_MEDIATION_FILL_RATE: 0.31,
              YIELD_GROUP_MEDIATION_PASSBACKS: 210000,
            },
          ],
        }] },
        { timezone: 'UTC' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(2);
  });

  it('breaks down by yield group with a secondary slice', async () => {
    const args = yieldBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-02' },
      by: 'yield_group',
      group_by: 'day',
    });
    const r = await yieldBreakdownTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: { dimensions: ['YIELD_GROUP_NAME', 'DATE'], metrics: METRICS },
          rows: [
            {
              YIELD_GROUP_NAME: 'Display Mediation',
              DATE: '2026-04-01',
              YIELD_GROUP_IMPRESSIONS: 500000,
              YIELD_GROUP_ESTIMATED_REVENUE: 750,
              YIELD_GROUP_ESTIMATED_CPM: 1.5,
              YIELD_GROUP_MEDIATION_FILL_RATE: 0.5,
              YIELD_GROUP_MEDIATION_PASSBACKS: 10000,
            },
            {
              YIELD_GROUP_NAME: 'Display Mediation',
              DATE: '2026-04-02',
              YIELD_GROUP_IMPRESSIONS: 500000,
              YIELD_GROUP_ESTIMATED_REVENUE: 750,
              YIELD_GROUP_ESTIMATED_CPM: 1.5,
              YIELD_GROUP_MEDIATION_FILL_RATE: 0.5,
              YIELD_GROUP_MEDIATION_PASSBACKS: 10000,
            },
          ],
        }] },
        { timezone: 'UTC' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(2);
  });
});
