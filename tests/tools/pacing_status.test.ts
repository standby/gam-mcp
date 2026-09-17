import { describe, it, expect } from 'vitest';
import { pacingStatusTool } from '../../src/tools/pacing_status.js';
import { makeCtx } from '../helpers.js';

const fixture = () => ({
  reports: [{
    query: { dimensions: ['LINE_ITEM_NAME', 'LINE_ITEM_ID'], metrics: ['IMPRESSIONS', 'REVENUE'] },
    rows: [{ LINE_ITEM_NAME: 'LI1', LINE_ITEM_ID: 123, IMPRESSIONS: 7800, REVENUE: 500 }],
  }],
});

describe('pacing_status', () => {
  it('returns pacing rows for currently-flighting line items', async () => {
    const ctx = makeCtx(fixture(), { timezone: 'America/Los_Angeles', now: new Date('2026-04-30T12:00:00Z') });
    const r = await pacingStatusTool.handler({}, ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
  });

  it('has provenance.report set and no file_path', async () => {
    const ctx = makeCtx(fixture(), { timezone: 'America/Los_Angeles', now: new Date('2026-04-30T12:00:00Z') });
    const r = await pacingStatusTool.handler({}, ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect((r.provenance as { report?: string } | undefined)?.report).toBeTruthy();
    expect(r).not.toHaveProperty('file_path');
  });
});
