import { describe, it, expect } from 'vitest';
import { revenueSummaryTool } from '../../src/tools/revenue_summary.js';
import { makeCtx } from '../helpers.js';

describe('revenue_summary', () => {
  it('groups by advertiser when group_by=advertiser', async () => {
    const ctx = makeCtx(
      { reports: [{
        query: {
          dimensions: ['ADVERTISER_ID', 'ADVERTISER_NAME'],
          metrics: ['REVENUE', 'IMPRESSIONS'],
        },
        rows: [{ ADVERTISER_ID: 1, ADVERTISER_NAME: 'Acme', REVENUE: 5000, IMPRESSIONS: 1000 }],
      }] },
      { timezone: 'America/Los_Angeles', now: new Date('2026-04-30T12:00:00Z') },
    );
    const r = await revenueSummaryTool.handler(
      { date_range: { start: '2026-04-01', end: '2026-04-29' }, group_by: 'advertiser' },
      ctx,
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
  });
});
