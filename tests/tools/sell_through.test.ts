import { describe, it, expect } from 'vitest';
import { sellThroughTool } from '../../src/tools/sell_through.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { makeCtx, NETWORK } from '../helpers.js';
import { definitionRange, type ReportDefinition } from '../../src/report-definition.js';

const METRICS = [
  'SELL_THROUGH_FORECASTED_IMPRESSIONS',
  'SELL_THROUGH_RESERVED_IMPRESSIONS',
  'SELL_THROUGH_AVAILABLE_IMPRESSIONS',
  'SELL_THROUGH_SELL_THROUGH_RATE',
];

// Wraps the mock so the query actually handed to GAM can be asserted on.
function spyClient(dimensions: string[], rows: Record<string, number | string>[]) {
  const mock = createMockGamClient({
    networkCode: NETWORK,
    reports: [{ query: { dimensions, metrics: METRICS }, rows }],
  });
  const seen: { definition?: ReportDefinition } = {};
  return {
    seen,
    client: {
      ...mock,
      defineReport: (definition: ReportDefinition) => {
        seen.definition = definition;
        return mock.defineReport(definition);
      },
    },
  };
}

describe('sell_through', () => {
  it('requests all four sell-through metrics under reportType FUTURE_SELL_THROUGH', async () => {
    const { seen, client } = spyClient(
      ['AD_UNIT_ID', 'AD_UNIT_NAME'],
      [
        {
          AD_UNIT_ID: 9001,
          AD_UNIT_NAME: 'Homepage',
          SELL_THROUGH_FORECASTED_IMPRESSIONS: 1000000,
          SELL_THROUGH_RESERVED_IMPRESSIONS: 750000,
          SELL_THROUGH_AVAILABLE_IMPRESSIONS: 250000,
          SELL_THROUGH_SELL_THROUGH_RATE: 0.75,
        },
        {
          AD_UNIT_ID: 9002,
          AD_UNIT_NAME: 'Article',
          SELL_THROUGH_FORECASTED_IMPRESSIONS: 400000,
          SELL_THROUGH_RESERVED_IMPRESSIONS: 400000,
          SELL_THROUGH_AVAILABLE_IMPRESSIONS: 0,
          SELL_THROUGH_SELL_THROUGH_RATE: 1.0,
        },
      ],
    );

    const args = sellThroughTool.input.parse({
      date_range: { start: '2026-09-17', end: '2026-09-30' },
      by: 'ad_unit',
    });
    const r = await sellThroughTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.definition?.reportType).toBe('FUTURE_SELL_THROUGH');
    expect(seen.definition?.metrics).toEqual(METRICS);
    expect(seen.definition?.dimensions).toEqual(['AD_UNIT_ID', 'AD_UNIT_NAME']);
    // The future window is passed through untouched.
    expect(definitionRange(seen.definition!)).toEqual({ start: '2026-09-17', end: '2026-09-30' });

    // Rows come back from the fixture, and available = forecasted - reserved.
    expect(r.total_row_count).toBe(2);
    const [first, second] = r.rows;
    expect(first.AD_UNIT_NAME).toBe('Homepage');
    expect(Number(first.SELL_THROUGH_AVAILABLE_IMPRESSIONS)).toBe(
      Number(first.SELL_THROUGH_FORECASTED_IMPRESSIONS) -
        Number(first.SELL_THROUGH_RESERVED_IMPRESSIONS),
    );
    // Fully booked: rate 1.0 and nothing left to sell.
    expect(Number(second.SELL_THROUGH_SELL_THROUGH_RATE)).toBe(1.0);
    expect(Number(second.SELL_THROUGH_AVAILABLE_IMPRESSIONS)).toBe(0);
  });

  it('filters on the primary id dimension when ids are given', async () => {
    const { seen, client } = spyClient(
      ['LINE_ITEM_ID', 'LINE_ITEM_NAME'],
      [{
        LINE_ITEM_ID: 55,
        LINE_ITEM_NAME: 'Q4 Guaranteed',
        SELL_THROUGH_FORECASTED_IMPRESSIONS: 2000000,
        SELL_THROUGH_RESERVED_IMPRESSIONS: 1800000,
        SELL_THROUGH_AVAILABLE_IMPRESSIONS: 200000,
        SELL_THROUGH_SELL_THROUGH_RATE: 0.9,
      }],
    );

    const args = sellThroughTool.input.parse({
      date_range: { start: '2026-10-01', end: '2026-10-31' },
      by: 'line_item',
      ids: [55],
    });
    const r = await sellThroughTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.definition?.filters).toEqual([
      { fieldFilter: { field: { dimension: 'LINE_ITEM_ID' }, operation: 'IN', values: [{ intValue: '55' }] } },
    ]);
    expect(seen.definition?.dimensions).toEqual(['LINE_ITEM_ID', 'LINE_ITEM_NAME']);
  });

  it('omits the filter entirely when no ids are given', async () => {
    const { seen, client } = spyClient(
      ['PLACEMENT_ID', 'PLACEMENT_NAME'],
      [{
        PLACEMENT_ID: 3,
        PLACEMENT_NAME: 'Run of Site',
        SELL_THROUGH_FORECASTED_IMPRESSIONS: 500000,
        SELL_THROUGH_RESERVED_IMPRESSIONS: 100000,
        SELL_THROUGH_AVAILABLE_IMPRESSIONS: 400000,
        SELL_THROUGH_SELL_THROUGH_RATE: 0.2,
      }],
    );

    const args = sellThroughTool.input.parse({
      date_range: { start: '2026-10-01', end: '2026-10-07' },
      by: 'placement',
    });
    const r = await sellThroughTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.definition?.filters).toBeUndefined();
  });

  it('warns that the numbers are forecasts that shift as bookings land', async () => {
    const { client } = spyClient(
      ['ORDER_ID', 'ORDER_NAME'],
      [{
        ORDER_ID: 7,
        ORDER_NAME: 'Q4 Direct',
        SELL_THROUGH_FORECASTED_IMPRESSIONS: 300000,
        SELL_THROUGH_RESERVED_IMPRESSIONS: 150000,
        SELL_THROUGH_AVAILABLE_IMPRESSIONS: 150000,
        SELL_THROUGH_SELL_THROUGH_RATE: 0.5,
      }],
    );

    const args = sellThroughTool.input.parse({
      date_range: { start: '2026-11-01', end: '2026-11-30' },
      by: 'order',
    });
    const r = await sellThroughTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    const warned = r.warnings.join(' ');
    expect(warned).toMatch(/forecasts, not measurements/i);
    expect(warned).toMatch(/accuracy degrades/i);
    expect(warned).toMatch(/booked as of right now/i);
  });

  // makeCtx's clock with timezone UTC: today is 2026-09-17.
  it('I14: refuses a window that starts yesterday, and a relative range; accepts one that starts today', async () => {
    const { seen, client } = spyClient(['AD_UNIT_ID', 'AD_UNIT_NAME'], []);
    const ctx = makeCtx({}, { client, timezone: 'UTC' });
    const run = (date_range: unknown) => sellThroughTool.handler(sellThroughTool.input.parse({ date_range }), ctx);

    expect(await run({ start: '2026-09-16', end: '2026-09-30' })).toMatchObject({
      error: { code: 'INVALID_DATE_RANGE', details: { field: 'date_range' } },
    });
    expect(await run({ relative: 'last_7_days' })).toMatchObject({ error: { code: 'INVALID_DATE_RANGE' } });
    expect(seen.definition).toBeUndefined();

    const r = await run({ start: '2026-09-17', end: '2026-09-17' });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.summary).toContain('2026-09-17..2026-09-17');
  });
});
