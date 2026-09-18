import { describe, it, expect } from 'vitest';
import { findAnomaliesTool } from '../../src/tools/find_anomalies.js';
import { PACING_DIMENSIONS } from '../../src/tools/pacing_status.js';
import { makeCtx } from '../helpers.js';

describe('find_anomalies', () => {
  it('I7: pacing_underdelivery flags only lifetime-goal items under the threshold', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      reports: [
        {
          query: { dimensions: PACING_DIMENSIONS, metrics: ['IMPRESSIONS'] },
          rows: [
            { LINE_ITEM_ID: 1, LINE_ITEM_NAME: 'HalfPaced', LINE_ITEM_TYPE: 'STANDARD', LINE_ITEM_PRIMARY_GOAL_TYPE: 'LIFETIME', LINE_ITEM_DELIVERY_INDICATOR: 0.5 },
            { LINE_ITEM_ID: 2, LINE_ITEM_NAME: 'OnTrack', LINE_ITEM_TYPE: 'STANDARD', LINE_ITEM_PRIMARY_GOAL_TYPE: 'LIFETIME', LINE_ITEM_DELIVERY_INDICATOR: 0.95 },
            // DAILY goal: never flagged, no matter how low its indicator is.
            { LINE_ITEM_ID: 3, LINE_ITEM_NAME: 'DailyLow', LINE_ITEM_TYPE: 'SPONSORSHIP', LINE_ITEM_PRIMARY_GOAL_TYPE: 'DAILY', LINE_ITEM_DELIVERY_INDICATOR: 0.1 },
          ],
        },
      ],
    }, { timezone: 'UTC', now });

    const args = findAnomaliesTool.input.parse({ kind: 'pacing_underdelivery', threshold_pct: 90 });
    const r = await findAnomaliesTool.handler(args, ctx);
    expect('rows' in r).toBe(true);
    if (!('rows' in r)) return;

    expect(r.rows!.map((x) => x.LINE_ITEM_NAME)).toEqual(['HalfPaced']);
    expect(r.rows![0].delivery_indicator).toBe(0.5);
  });

  it('I7: sorts flagged items by indicator ascending, worst first', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const ctx = makeCtx({
      reports: [
        {
          query: { dimensions: PACING_DIMENSIONS, metrics: ['IMPRESSIONS'] },
          rows: [
            { LINE_ITEM_ID: 1, LINE_ITEM_NAME: 'Worse', LINE_ITEM_TYPE: 'STANDARD', LINE_ITEM_PRIMARY_GOAL_TYPE: 'LIFETIME', LINE_ITEM_DELIVERY_INDICATOR: 0.3 },
            { LINE_ITEM_ID: 2, LINE_ITEM_NAME: 'Worst', LINE_ITEM_TYPE: 'STANDARD', LINE_ITEM_PRIMARY_GOAL_TYPE: 'LIFETIME', LINE_ITEM_DELIVERY_INDICATOR: 0.1 },
            { LINE_ITEM_ID: 3, LINE_ITEM_NAME: 'BarelyUnder', LINE_ITEM_TYPE: 'STANDARD', LINE_ITEM_PRIMARY_GOAL_TYPE: 'LIFETIME', LINE_ITEM_DELIVERY_INDICATOR: 0.79 },
          ],
        },
      ],
    }, { timezone: 'UTC', now });

    const args = findAnomaliesTool.input.parse({ kind: 'pacing_underdelivery' }); // default threshold_pct 80
    const r = await findAnomaliesTool.handler(args, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));
    expect(r.rows!.map((x) => x.LINE_ITEM_NAME)).toEqual(['Worst', 'Worse', 'BarelyUnder']);
  });

  it('ecpm_regression flags buyer networks whose AdX eCPM dropped WoW past threshold', async () => {
    // last_7_days at now=2026-04-15 → base [04-08..04-14], prev [04-01..04-07]
    const now = new Date('2026-04-15T12:00:00Z');
    const query = {
      dimensions: ['BUYER_NETWORK_NAME'],
      metrics: ['AD_EXCHANGE_IMPRESSIONS', 'AD_EXCHANGE_REVENUE', 'AD_EXCHANGE_AVERAGE_ECPM'],
    };
    const ctx = makeCtx({
      reports: [
        // base (last 7 days) — DSP_A dropped to $1.00, DSP_B flat
        {
          query,
          dateRange: { start: '2026-04-08', end: '2026-04-14' },
          rows: [
            // eCPM fell from 2.0 → 1.0 (50% drop)
            { BUYER_NETWORK_NAME: 'DSP_A', AD_EXCHANGE_IMPRESSIONS: 1_000_000, AD_EXCHANGE_REVENUE: 1000, AD_EXCHANGE_AVERAGE_ECPM: 1.0 },
            // flat
            { BUYER_NETWORK_NAME: 'DSP_B', AD_EXCHANGE_IMPRESSIONS: 800_000, AD_EXCHANGE_REVENUE: 1600, AD_EXCHANGE_AVERAGE_ECPM: 2.0 },
            // < 10k imps → filtered as noise
            { BUYER_NETWORK_NAME: 'DSP_LowVol', AD_EXCHANGE_IMPRESSIONS: 500, AD_EXCHANGE_REVENUE: 5, AD_EXCHANGE_AVERAGE_ECPM: 10.0 },
          ],
        },
        // prev (week before)
        {
          query,
          dateRange: { start: '2026-04-01', end: '2026-04-07' },
          rows: [
            { BUYER_NETWORK_NAME: 'DSP_A', AD_EXCHANGE_IMPRESSIONS: 1_200_000, AD_EXCHANGE_REVENUE: 2400, AD_EXCHANGE_AVERAGE_ECPM: 2.0 },
            { BUYER_NETWORK_NAME: 'DSP_B', AD_EXCHANGE_IMPRESSIONS: 900_000, AD_EXCHANGE_REVENUE: 1800, AD_EXCHANGE_AVERAGE_ECPM: 2.0 },
            { BUYER_NETWORK_NAME: 'DSP_LowVol', AD_EXCHANGE_IMPRESSIONS: 500, AD_EXCHANGE_REVENUE: 5, AD_EXCHANGE_AVERAGE_ECPM: 10.0 },
          ],
        },
      ],
    }, { timezone: 'UTC', now });

    const args = findAnomaliesTool.input.parse({ kind: 'ecpm_regression' });
    const r = await findAnomaliesTool.handler(args, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));

    expect(r.rows!.map((x) => x.BUYER_NETWORK_NAME)).toEqual(['DSP_A']);
    expect(r.rows![0].ecpm_now).toBe('1.00');
    expect(r.rows![0].ecpm_prev).toBe('2.00');
    expect(Number(r.rows![0].drop_pct)).toBeCloseTo(50.0, 1);
  });

  it('viewability_drops flags ad units whose viewable-impression rate fell WoW', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const query = {
      dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
      metrics: ['IMPRESSIONS', 'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE'],
    };
    const ctx = makeCtx({
      reports: [
        {
          query,
          dateRange: { start: '2026-04-08', end: '2026-04-14' },
          rows: [
            // rate is 0..1 fraction in GAM; .60 = 60%
            // dropped 20pp from 80% → 60%
            { AD_UNIT_ID: 100, AD_UNIT_NAME: 'TopBanner', IMPRESSIONS: 500_000, ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: 0.60 },
            // flat
            { AD_UNIT_ID: 200, AD_UNIT_NAME: 'Sidebar', IMPRESSIONS: 500_000, ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: 0.75 },
            // < 10k imps → filtered
            { AD_UNIT_ID: 300, AD_UNIT_NAME: 'LowVol', IMPRESSIONS: 1000, ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: 0.40 },
          ],
        },
        {
          query,
          dateRange: { start: '2026-04-01', end: '2026-04-07' },
          rows: [
            { AD_UNIT_ID: 100, AD_UNIT_NAME: 'TopBanner', IMPRESSIONS: 600_000, ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: 0.80 },
            { AD_UNIT_ID: 200, AD_UNIT_NAME: 'Sidebar', IMPRESSIONS: 600_000, ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: 0.75 },
            { AD_UNIT_ID: 300, AD_UNIT_NAME: 'LowVol', IMPRESSIONS: 1000, ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE: 0.80 },
          ],
        },
      ],
    }, { timezone: 'UTC', now });

    const args = findAnomaliesTool.input.parse({ kind: 'viewability_drops' });
    const r = await findAnomaliesTool.handler(args, ctx);
    if (!('rows' in r)) throw new Error(JSON.stringify(r));

    expect(r.rows!.map((x) => x.AD_UNIT_NAME)).toEqual(['TopBanner']);
    expect(r.rows![0].viewability_now_pct).toBe('60.00');
    expect(r.rows![0].viewability_prev_pct).toBe('80.00');
    expect(Number(r.rows![0].drop_pp)).toBeCloseTo(20.0, 1);
  });

  it('names the single input report in provenance', async () => {
    const now = new Date('2026-04-15T12:00:00Z');
    const query = { dimensions: PACING_DIMENSIONS, metrics: ['IMPRESSIONS'] };
    const ctx = makeCtx({
      reports: [{
        query,
        rows: [
          { LINE_ITEM_ID: 1, LINE_ITEM_NAME: 'Under', LINE_ITEM_TYPE: 'STANDARD', LINE_ITEM_PRIMARY_GOAL_TYPE: 'LIFETIME', LINE_ITEM_DELIVERY_INDICATOR: 0.5 },
        ],
      }],
    }, { timezone: 'UTC', now });

    const args = findAnomaliesTool.input.parse({ kind: 'pacing_underdelivery' });
    const r = await findAnomaliesTool.handler(args, ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const inputs = (r as { provenance: { inputs: unknown[] } }).provenance.inputs;
    expect(inputs).toHaveLength(1);
  });
});
