import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sellThroughTool } from '../../src/tools/sell_through.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';
import type { ReportQuery, DateRange } from '../../src/gam-client.js';

const METRICS = [
  'SELL_THROUGH_FORECASTED_IMPRESSIONS',
  'SELL_THROUGH_RESERVED_IMPRESSIONS',
  'SELL_THROUGH_AVAILABLE_IMPRESSIONS',
  'SELL_THROUGH_SELL_THROUGH_RATE',
];

const ctx = (dir: string, client: ReturnType<typeof createMockGamClient>) => ({
  client,
  output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
  timezone: 'UTC',
  logger: noopLogger(),
});

// Wraps the mock so the query actually handed to GAM can be asserted on.
function spyClient(dimensions: string[], csv: string) {
  const mock = createMockGamClient({
    reports: [{ query: { dimensions, metrics: METRICS }, csvGz: gzipSync(Buffer.from(csv)) }],
  });
  const seen: { query?: ReportQuery; dateRange?: DateRange } = {};
  return {
    seen,
    client: {
      ...mock,
      createReport: (q: ReportQuery, dr: DateRange) => {
        seen.query = q;
        seen.dateRange = dr;
        return mock.createReport(q, dr);
      },
    },
  };
}

describe('sell_through', () => {
  it('requests all four sell-through metrics under reportType FUTURE_SELL_THROUGH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const { seen, client } = spyClient(
      ['AD_UNIT_ID', 'AD_UNIT_NAME'],
      'ad_unit_id,ad_unit_name,sell_through_forecasted_impressions,sell_through_reserved_impressions,sell_through_available_impressions,sell_through_sell_through_rate\n' +
        '9001,Homepage,1000000,750000,250000,0.75\n' +
        '9002,Article,400000,400000,0,1.0\n',
    );

    const args = sellThroughTool.input.parse({
      date_range: { start: '2026-09-01', end: '2026-09-30' },
      by: 'ad_unit',
    });
    const r = await sellThroughTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.query?.report_type).toBe('FUTURE_SELL_THROUGH');
    expect(seen.query?.metrics).toEqual(METRICS);
    expect(seen.query?.dimensions).toEqual(['AD_UNIT_ID', 'AD_UNIT_NAME']);
    // The future window is passed through untouched.
    expect(seen.dateRange).toEqual({ start: '2026-09-01', end: '2026-09-30' });

    // Rows come back from the fixture, and available = forecasted - reserved.
    expect(r.row_count).toBe(2);
    const [first, second] = r.rows ?? [];
    expect(first.ad_unit_name).toBe('Homepage');
    expect(Number(first.sell_through_available_impressions)).toBe(
      Number(first.sell_through_forecasted_impressions) -
        Number(first.sell_through_reserved_impressions),
    );
    // Fully booked: rate 1.0 and nothing left to sell.
    expect(Number(second.sell_through_sell_through_rate)).toBe(1.0);
    expect(Number(second.sell_through_available_impressions)).toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it('filters on the primary id dimension when ids are given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const { seen, client } = spyClient(
      ['LINE_ITEM_ID', 'LINE_ITEM_NAME'],
      'line_item_id,line_item_name,sell_through_forecasted_impressions,sell_through_reserved_impressions,sell_through_available_impressions,sell_through_sell_through_rate\n' +
        '55,Q4 Guaranteed,2000000,1800000,200000,0.9\n',
    );

    const args = sellThroughTool.input.parse({
      date_range: { start: '2026-10-01', end: '2026-10-31' },
      by: 'line_item',
      ids: [55],
    });
    const r = await sellThroughTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.query?.filters).toEqual([{ field: 'LINE_ITEM_ID', op: 'IN', value: [55] }]);
    expect(seen.query?.dimensions).toEqual(['LINE_ITEM_ID', 'LINE_ITEM_NAME']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('omits the filter entirely when no ids are given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const { seen, client } = spyClient(
      ['PLACEMENT_ID', 'PLACEMENT_NAME'],
      'placement_id,placement_name,sell_through_forecasted_impressions,sell_through_reserved_impressions,sell_through_available_impressions,sell_through_sell_through_rate\n' +
        '3,Run of Site,500000,100000,400000,0.2\n',
    );

    const args = sellThroughTool.input.parse({
      date_range: { start: '2026-08-01', end: '2026-08-07' },
      by: 'placement',
    });
    const r = await sellThroughTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.query?.filters).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns that the numbers are forecasts that shift as bookings land', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'st-'));
    const { client } = spyClient(
      ['ORDER_ID', 'ORDER_NAME'],
      'order_id,order_name,sell_through_forecasted_impressions,sell_through_reserved_impressions,sell_through_available_impressions,sell_through_sell_through_rate\n' +
        '7,Q4 Direct,300000,150000,150000,0.5\n',
    );

    const args = sellThroughTool.input.parse({
      date_range: { start: '2026-11-01', end: '2026-11-30' },
      by: 'order',
    });
    const r = await sellThroughTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    const warned = r.warnings?.join(' ') ?? '';
    expect(warned).toMatch(/forecasts, not measurements/i);
    expect(warned).toMatch(/accuracy degrades/i);
    expect(warned).toMatch(/booked as of right now/i);
    rmSync(dir, { recursive: true, force: true });
  });
});
