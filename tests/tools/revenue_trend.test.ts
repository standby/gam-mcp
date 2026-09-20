import { describe, it, expect } from 'vitest';
import { revenueTrendTool } from '../../src/tools/revenue_trend.js';
import { makeCtx } from '../helpers.js';

describe('revenue_trend', () => {
  it('returns daily series', async () => {
    const args = revenueTrendTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
      granularity: 'day',
    });
    const r = await revenueTrendTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: {
            dimensions: ['DATE'],
            metrics: ['REVENUE', 'IMPRESSIONS'],
          },
          rows: [
            { DATE: '2026-04-01', REVENUE: 100, IMPRESSIONS: 1000 },
            { DATE: '2026-04-02', REVENUE: 150, IMPRESSIONS: 1500 },
          ],
        }] },
        { timezone: 'UTC' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(2);
  });
});
