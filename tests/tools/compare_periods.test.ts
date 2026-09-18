import { describe, it, expect } from 'vitest';
import { comparePeriodsTool } from '../../src/tools/compare_periods.js';
import { makeCtx } from '../helpers.js';

describe('compare_periods', () => {
  it('joins base and previous_period rows, emits delta_pct, includes one-sided rows', async () => {
    const query = { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] };
    const ctx = makeCtx({
      reports: [
        // BASE period (last 7 days)
        {
          query,
          dateRange: { start: '2026-04-23', end: '2026-04-29' },
          rows: [
            { ADVERTISER_NAME: 'Acme', IMPRESSIONS: 1000 },
            { ADVERTISER_NAME: 'Beta', IMPRESSIONS: 200 },
            { ADVERTISER_NAME: 'NewCo', IMPRESSIONS: 50 },
          ],
        },
        // PREV period (previous_period -> 2026-04-16..22)
        {
          query,
          dateRange: { start: '2026-04-16', end: '2026-04-22' },
          rows: [
            { ADVERTISER_NAME: 'Acme', IMPRESSIONS: 800 },
            { ADVERTISER_NAME: 'Beta', IMPRESSIONS: 250 },
            { ADVERTISER_NAME: 'Gone', IMPRESSIONS: 99 },
          ],
        },
      ],
    }, { timezone: 'UTC' });

    const args = comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_NAME'],
      metrics: ['IMPRESSIONS'],
      base_range: { start: '2026-04-23', end: '2026-04-29' },
      comparison: 'previous_period',
    });
    const r = await comparePeriodsTool.handler(args, ctx);
    expect('rows' in r).toBe(true);
    if (!('rows' in r)) return;
    const byAdv = Object.fromEntries(r.rows!.map((row) => [row.ADVERTISER_NAME, row]));

    expect(byAdv.Acme.IMPRESSIONS).toBe('1000');
    expect(byAdv.Acme.IMPRESSIONS_prev).toBe('800');
    expect(byAdv.Acme.IMPRESSIONS_delta_pct).toBe('25.00');

    expect(byAdv.Beta.IMPRESSIONS).toBe('200');
    expect(byAdv.Beta.IMPRESSIONS_prev).toBe('250');
    expect(byAdv.Beta.IMPRESSIONS_delta_pct).toBe('-20.00');

    // NewCo only in base — prev is null, delta_pct empty
    expect(byAdv.NewCo.IMPRESSIONS).toBe('50');
    expect(byAdv.NewCo.IMPRESSIONS_prev).toBe('');
    expect(byAdv.NewCo.IMPRESSIONS_delta_pct).toBe('');

    // Gone only in prev — base is null
    expect(byAdv.Gone.IMPRESSIONS).toBe('');
    expect(byAdv.Gone.IMPRESSIONS_prev).toBe('99');
    expect(byAdv.Gone.IMPRESSIONS_delta_pct).toBe('');

    // Sorted by primary metric (IMPRESSIONS) descending — Acme first
    expect(r.rows![0].ADVERTISER_NAME).toBe('Acme');
  });

  it('rejects unknown metrics with an actionable hint', async () => {
    const ctx = makeCtx({}, { timezone: 'UTC' });
    const args = comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_NAME'],
      metrics: ['NOT_A_METRIC'],
      base_range: { start: '2026-04-23', end: '2026-04-29' },
      comparison: 'previous_period',
    });
    const r = await comparePeriodsTool.handler(args, ctx);
    expect('error' in r).toBe(true);
    if ('error' in r) expect((r.error as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('names both input reports in provenance', async () => {
    const query = { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] };
    const ctx = makeCtx({ reports: [
      { query, dateRange: { start: '2026-04-08', end: '2026-04-14' }, rows: [{ ADVERTISER_NAME: 'A', IMPRESSIONS: 20 }] },
      { query, dateRange: { start: '2026-04-01', end: '2026-04-07' }, rows: [{ ADVERTISER_NAME: 'A', IMPRESSIONS: 10 }] },
    ] }, { now: new Date('2026-04-20T12:00:00Z') });
    const r = await comparePeriodsTool.handler(comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'],
      base_range: { start: '2026-04-08', end: '2026-04-14' }, comparison: 'previous_period',
    }), ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const inputs = (r as { provenance: { inputs: { date_range: unknown }[] } }).provenance.inputs;
    expect(inputs.map((i) => i.date_range)).toEqual([
      { start: '2026-04-08', end: '2026-04-14' },
      { start: '2026-04-01', end: '2026-04-07' },
    ]);
  });

  it('keys on the full dimension tuple, not the concatenation of its parts', async () => {
    // ('1','23') and ('12','3') concatenate to the same string ("123") if the
    // join key has no separator between dimension values — this must not
    // pair either row with the other's previous-period counterpart.
    const query = { dimensions: ['ADVERTISER_NAME', 'ORDER_NAME'], metrics: ['IMPRESSIONS'] };
    const ctx = makeCtx({
      reports: [
        {
          query,
          dateRange: { start: '2026-04-08', end: '2026-04-14' },
          rows: [
            { ADVERTISER_NAME: '1', ORDER_NAME: '23', IMPRESSIONS: 100 },
            { ADVERTISER_NAME: '12', ORDER_NAME: '3', IMPRESSIONS: 200 },
          ],
        },
        {
          query,
          dateRange: { start: '2026-04-01', end: '2026-04-07' },
          rows: [
            { ADVERTISER_NAME: '1', ORDER_NAME: '23', IMPRESSIONS: 10 },
            { ADVERTISER_NAME: '12', ORDER_NAME: '3', IMPRESSIONS: 20 },
          ],
        },
      ],
    }, { timezone: 'UTC' });

    const args = comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_NAME', 'ORDER_NAME'],
      metrics: ['IMPRESSIONS'],
      base_range: { start: '2026-04-08', end: '2026-04-14' },
      comparison: 'previous_period',
    });
    const r = await comparePeriodsTool.handler(args, ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const byKey = Object.fromEntries(
      r.rows!.map((row) => [`${row.ADVERTISER_NAME}|${row.ORDER_NAME}`, row]),
    );

    expect(byKey['1|23'].IMPRESSIONS).toBe('100');
    expect(byKey['1|23'].IMPRESSIONS_prev).toBe('10');

    expect(byKey['12|3'].IMPRESSIONS).toBe('200');
    expect(byKey['12|3'].IMPRESSIONS_prev).toBe('20');
  });

  it('accepts the CREATIVE_SIZE alias in dimensions and a same-named filter (refused before canonicalizeQuery)', async () => {
    const query = { dimensions: ['RENDERED_CREATIVE_SIZE'], metrics: ['IMPRESSIONS'] };
    const ctx = makeCtx({
      reports: [
        {
          query,
          dateRange: { start: '2026-04-23', end: '2026-04-29' },
          rows: [{ RENDERED_CREATIVE_SIZE: '300x250', IMPRESSIONS: 100 }],
        },
        {
          query,
          dateRange: { start: '2026-04-16', end: '2026-04-22' },
          rows: [{ RENDERED_CREATIVE_SIZE: '300x250', IMPRESSIONS: 80 }],
        },
      ],
    }, { timezone: 'UTC' });

    const args = comparePeriodsTool.input.parse({
      dimensions: ['CREATIVE_SIZE'],
      metrics: ['IMPRESSIONS'],
      base_range: { start: '2026-04-23', end: '2026-04-29' },
      comparison: 'previous_period',
      filters: [{ field: 'CREATIVE_SIZE', op: '=', value: '300x250' }],
    });
    const r = await comparePeriodsTool.handler(args, ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.rows![0].RENDERED_CREATIVE_SIZE).toBe('300x250');
    expect(r.warnings.join(' ')).toMatch(/CREATIVE_SIZE.*RENDERED_CREATIVE_SIZE/);
  });
});
