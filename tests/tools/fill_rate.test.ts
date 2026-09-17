import { describe, it, expect } from 'vitest';
import { fillRateTool } from '../../src/tools/fill_rate.js';
import { makeCtx } from '../helpers.js';

describe('fill_rate', () => {
  it('reports fill rate grouped by ad_unit', async () => {
    const r = await fillRateTool.handler(
      { date_range: { start: '2026-04-01', end: '2026-04-29' }, group_by: 'ad_unit' },
      makeCtx(
        { reports: [{
          query: {
            dimensions: ['AD_UNIT_NAME'],
            metrics: ['AD_REQUESTS', 'UNFILLED_IMPRESSIONS', 'FILL_RATE'],
          },
          rows: [{ AD_UNIT_NAME: '/home', AD_REQUESTS: 1000, UNFILLED_IMPRESSIONS: 100, FILL_RATE: 0.9 }],
        }] },
        { timezone: 'America/Los_Angeles' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
  });
});
