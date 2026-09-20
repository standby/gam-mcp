import { describe, it, expect } from 'vitest';
import { topAdvertisersTool } from '../../src/tools/top_advertisers.js';
import { makeCtx } from '../helpers.js';

describe('top_advertisers', () => {
  it('queries advertiser dimension with chosen metric', async () => {
    const args = topAdvertisersTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-29' },
      top_n: 10,
      metric: 'revenue',
    });
    const r = await topAdvertisersTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: { dimensions: ['ADVERTISER_ID', 'ADVERTISER_NAME'], metrics: ['REVENUE'] },
          rows: [
            { ADVERTISER_ID: 1, ADVERTISER_NAME: 'Acme', REVENUE: 9999 },
            { ADVERTISER_ID: 2, ADVERTISER_NAME: 'Beta', REVENUE: 500 },
          ],
        }] },
        { timezone: 'America/Los_Angeles' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(2);
  });
});
