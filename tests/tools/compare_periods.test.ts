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
    // derived block: key order is value, method, heuristic, inputs (derived()
    // never emits `reason` here — compare_periods never passes one).
    expect(Object.keys(byAdv.Acme.IMPRESSIONS_delta_pct as object)).toEqual(['value', 'method', 'heuristic', 'inputs']);
    expect(byAdv.Acme.IMPRESSIONS_delta_pct).toMatchObject({
      value: 25,
      heuristic: false,
      inputs: { IMPRESSIONS_now: 1000, IMPRESSIONS_prev: 800 },
    });
    expect((byAdv.Acme.IMPRESSIONS_delta_pct as { method: string }).method).toMatch(/percent change/i);

    expect(byAdv.Beta.IMPRESSIONS).toBe('200');
    expect(byAdv.Beta.IMPRESSIONS_prev).toBe('250');
    expect(byAdv.Beta.IMPRESSIONS_delta_pct).toMatchObject({ value: -20 });

    // NewCo only in base — prev is missing (a null input): delta_pct.value
    // is null, and the row is counted in the null-input warning.
    expect(byAdv.NewCo.IMPRESSIONS).toBe('50');
    expect(byAdv.NewCo.IMPRESSIONS_prev).toBeNull();
    expect(byAdv.NewCo.IMPRESSIONS_prev).not.toBe('');
    expect(byAdv.NewCo.IMPRESSIONS_delta_pct).toMatchObject({
      value: null,
      inputs: { IMPRESSIONS_now: 50, IMPRESSIONS_prev: null },
    });

    // Gone only in prev — base is missing (a null input) too.
    expect(byAdv.Gone.IMPRESSIONS).toBeNull();
    expect(byAdv.Gone.IMPRESSIONS).not.toBe('');
    expect(byAdv.Gone.IMPRESSIONS_prev).toBe('99');
    expect(byAdv.Gone.IMPRESSIONS_delta_pct).toMatchObject({ value: null });

    // Two rows (NewCo, Gone) had a metric missing on one side.
    expect(r.warnings.join(' ')).toMatch(/2 row\(s\) had a null input/);

    // Sorted by primary metric (IMPRESSIONS) descending — Acme first
    expect(r.rows![0].ADVERTISER_NAME).toBe('Acme');
  });

  // Regression for the two-sentinels defect: <metric>/<metric>_prev used to
  // emit '' for a missing side while <metric>_delta_pct.value emitted null
  // for the same absence. Every other §1.4 tool uses null for "not
  // reported" in a numeric column, so the raw fields must agree with the
  // derived one beside them.
  it('a metric missing on one side is null, not an empty string', async () => {
    const query = { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] };
    const ctx = makeCtx({
      reports: [
        // BASE period reports the metric.
        {
          query,
          dateRange: { start: '2026-04-23', end: '2026-04-29' },
          rows: [{ ADVERTISER_NAME: 'Acme', IMPRESSIONS: 1000 }],
        },
        // PREVIOUS period exists (dateRange matches) but never reports Acme.
        {
          query,
          dateRange: { start: '2026-04-16', end: '2026-04-22' },
          rows: [],
        },
      ],
    }, { timezone: 'UTC' });

    const args = comparePeriodsTool.input.parse({
      dimensions: ['ADVERTISER_NAME'],
      metrics: ['IMPRESSIONS'],
      base_range: { start: '2026-04-23', end: '2026-04-29' },
      comparison: 'previous_period',
      top_n: 10,
    });
    const r = await comparePeriodsTool.handler(args, ctx);
    if ('error' in r) throw new Error(JSON.stringify(r));
    const row = r.rows![0];

    // Present side is still a numeric string (unchanged behaviour).
    expect(row.IMPRESSIONS).toBe('1000');
    // Absent side is null, not ''.
    expect(row.IMPRESSIONS_prev).toBeNull();
    expect(row.IMPRESSIONS_prev).not.toBe('');
    // The computed field beside it already agreed (PR 4); this just confirms
    // both sentinels now describe the same absence the same way.
    expect(row.IMPRESSIONS_delta_pct).toMatchObject({ value: null });
  });

  it('prev === 0: both periods zero yields value 0 (not a null input); prev 0 with a nonzero base yields ' +
     'value null (undefined change) but is NOT counted as a null-input row', async () => {
    const query = { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] };
    const ctx = makeCtx({
      reports: [
        {
          query,
          dateRange: { start: '2026-04-23', end: '2026-04-29' },
          rows: [
            { ADVERTISER_NAME: 'BothZero', IMPRESSIONS: 0 },
            { ADVERTISER_NAME: 'GrewFromZero', IMPRESSIONS: 100 },
          ],
        },
        {
          query,
          dateRange: { start: '2026-04-16', end: '2026-04-22' },
          rows: [
            { ADVERTISER_NAME: 'BothZero', IMPRESSIONS: 0 },
            { ADVERTISER_NAME: 'GrewFromZero', IMPRESSIONS: 0 },
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
    if ('error' in r) throw new Error(JSON.stringify(r));
    const byAdv = Object.fromEntries(r.rows!.map((row) => [row.ADVERTISER_NAME, row]));

    expect(byAdv.BothZero.IMPRESSIONS_delta_pct).toMatchObject({ value: 0 });
    expect(byAdv.GrewFromZero.IMPRESSIONS_delta_pct).toMatchObject({ value: null });

    // Neither row is a null-input row: both metrics were reported on both
    // sides (0 is a known value, not a missing one), so no warning fires.
    expect(r.warnings.join(' ')).not.toMatch(/null input/);
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
