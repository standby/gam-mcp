import { describe, it, expect } from 'vitest';
import { pacingStatusTool } from '../../src/tools/pacing_status.js';
import { createFakeGam, int, dbl, str } from '../fake-gam.js';
import { restCtx } from '../helpers.js';
import type { ReportValue } from '../../src/values.js';

const bool = (b: boolean): ReportValue => ({ boolValue: b });

// A LIFETIME-goal line item. indicator omitted -> GAM did not report one for
// this row (an all-empty column falls back to the declared schema type --
// trap #2, spec line 79 / schema-generated.ts:306).
function lifetimeRow(over: {
  id?: number; name?: string; indicator?: number; endDate?: string; unlimitedEnd?: boolean;
} = {}): Record<string, ReportValue> {
  return {
    LINE_ITEM_ID: int(over.id ?? 1),
    LINE_ITEM_NAME: str(over.name ?? 'Lifetime line item'),
    LINE_ITEM_TYPE: str('STANDARD'),
    LINE_ITEM_PRIMARY_GOAL_TYPE: str('LIFETIME'),
    LINE_ITEM_PRIMARY_GOAL_UNIT_TYPE: str('IMPRESSIONS'),
    LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE: int(100_000),
    LINE_ITEM_START_DATE: int('20260901'),
    LINE_ITEM_END_DATE: int(over.endDate ?? '20261231'),
    LINE_ITEM_UNLIMITED_END: bool(over.unlimitedEnd ?? false),
    LINE_ITEM_LIFETIME_IMPRESSIONS: int(60_000),
    IMPRESSIONS: int(6_000),
    ...(over.indicator !== undefined && { LINE_ITEM_DELIVERY_INDICATOR: dbl(over.indicator) }),
  };
}

// A DAILY-goal line item: delivery_indicator is not ours to reinterpret, no
// matter what GAM sends for it.
function dailyRow(over: { id?: number; name?: string; indicator?: number } = {}): Record<string, ReportValue> {
  return {
    LINE_ITEM_ID: int(over.id ?? 2),
    LINE_ITEM_NAME: str(over.name ?? 'Daily line item'),
    LINE_ITEM_TYPE: str('SPONSORSHIP'),
    LINE_ITEM_PRIMARY_GOAL_TYPE: str('DAILY'),
    LINE_ITEM_PRIMARY_GOAL_UNIT_TYPE: str('IMPRESSIONS'),
    LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE: int(1_000),
    LINE_ITEM_START_DATE: int('20260901'),
    LINE_ITEM_END_DATE: int('20261231'),
    LINE_ITEM_UNLIMITED_END: bool(false),
    LINE_ITEM_LIFETIME_IMPRESSIONS: int(900),
    IMPRESSIONS: int(90),
    ...(over.indicator !== undefined && { LINE_ITEM_DELIVERY_INDICATOR: dbl(over.indicator) }),
  };
}

// A LIFETIME row with LINE_ITEM_UNLIMITED_END sent as a specific raw wire
// value (or omitted, when `cell` is undefined) -- the declared schema type
// ("string") cannot be trusted for this field any more than it can for
// LINE_ITEM_DELIVERY_INDICATOR (spec line 79), so both a real boolValue and a
// stringValue form must be exercised.
function unlimitedEndRow(id: number, cell: ReportValue | undefined): Record<string, ReportValue> {
  const row = lifetimeRow({ id, endDate: '20370101' });
  if (cell === undefined) {
    const { LINE_ITEM_UNLIMITED_END: _drop, ...rest } = row;
    return rest;
  }
  return { ...row, LINE_ITEM_UNLIMITED_END: cell };
}

// A LIFETIME-shaped row (real, non-null indicator, so a gating bug would leak
// it) with LINE_ITEM_PRIMARY_GOAL_TYPE overridden or omitted entirely.
function goalTypeRow(id: number, cell: ReportValue | undefined): Record<string, ReportValue> {
  const row = lifetimeRow({ id, indicator: 0.5 });
  if (cell === undefined) {
    const { LINE_ITEM_PRIMARY_GOAL_TYPE: _drop, ...rest } = row;
    return rest;
  }
  return { ...row, LINE_ITEM_PRIMARY_GOAL_TYPE: cell };
}

describe('pacing_status', () => {
  it('I6: with no date_range it defaults to last_7_days and works on the 1st', async () => {
    const gam = createFakeGam();
    gam.setRows({ byColumn: [lifetimeRow({ indicator: 0.82 })] });
    // The clock that makes today's month_to_date-based code return INVALID_DATE_RANGE.
    const ctx = restCtx(gam, { now: new Date('2026-10-01T00:00:00Z') }); // 09:00 in Asia/Tokyo (makeCtx's zone)
    const r = await pacingStatusTool.handler({} as never, ctx) as Record<string, any>;
    expect(r.error).toBeUndefined();
    expect(r.provenance.inputs[0].date_range).toBeDefined();
  });

  it('I6: a LIFETIME goal reports GAM indicator unchanged; others are null with a reason', async () => {
    const gam = createFakeGam();
    gam.setRows({ byColumn: [
      lifetimeRow({ id: 1, indicator: 0.82 }),
      dailyRow({ id: 2, indicator: 0 }),
    ] });
    const r = await pacingStatusTool.handler({} as never, restCtx(gam)) as Record<string, any>;
    const [lifetime, daily] = r.rows;
    expect(lifetime.delivery_indicator).toBe(0.82);
    // A DAILY item's indicator is not ours to reinterpret, and 0 is not null.
    expect(daily.delivery_indicator).toBeNull();
    expect(daily.derived.reason).toBe('no lifetime goal');
    expect(r.warnings.join(' ')).toMatch(/live values/i);
  });

  it('a LIFETIME goal with no reported indicator is null, not 0, and counted as a null input', async () => {
    const gam = createFakeGam();
    gam.setRows({ byColumn: [lifetimeRow({ id: 1 })] }); // indicator omitted entirely
    const r = await pacingStatusTool.handler({} as never, restCtx(gam)) as Record<string, any>;
    expect(r.rows[0].delivery_indicator).toBeNull();
    expect(r.rows[0].derived.value).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/1 row\(s\) had a null input to a computed field/);
  });

  it('I13: an unlimited-end line item has a null end date, not 2037-01-01', async () => {
    const gam = createFakeGam();
    gam.setRows({ byColumn: [
      lifetimeRow({ id: 1, endDate: '20370101', unlimitedEnd: true }),
      lifetimeRow({ id: 2, endDate: '20370101', unlimitedEnd: false }),
    ] });
    const r = await pacingStatusTool.handler({} as never, restCtx(gam)) as Record<string, any>;
    const [unlimited, limited] = r.rows;
    expect(unlimited.LINE_ITEM_END_DATE).toBeNull();
    expect(limited.LINE_ITEM_END_DATE).toBe('2037-01-01');
  });

  it('LINE_ITEM_UNLIMITED_END is read from either wire form GAM might send, case-insensitively', async () => {
    const gam = createFakeGam();
    gam.setRows({ byColumn: [
      unlimitedEndRow(1, { boolValue: true }),
      unlimitedEndRow(2, { stringValue: 'true' }),
      unlimitedEndRow(3, { stringValue: ' True ' }), // trimmed, case-insensitive
      unlimitedEndRow(4, { stringValue: 'false' }),
      unlimitedEndRow(5, undefined), // absent -> conservative: real date survives
    ] });
    const r = await pacingStatusTool.handler({} as never, restCtx(gam)) as Record<string, any>;
    const [boolTrue, strTrue, strTrueSpaced, strFalse, absent] = r.rows;
    expect(boolTrue.LINE_ITEM_END_DATE).toBeNull();
    expect(strTrue.LINE_ITEM_END_DATE).toBeNull();
    expect(strTrueSpaced.LINE_ITEM_END_DATE).toBeNull();
    expect(strFalse.LINE_ITEM_END_DATE).toBe('2037-01-01');
    expect(absent.LINE_ITEM_END_DATE).toBe('2037-01-01');
  });

  it('a missing or unrecognized primary goal type is never LIFETIME: null indicator, real reason, no leak', async () => {
    const gam = createFakeGam();
    gam.setRows({ byColumn: [
      goalTypeRow(1, undefined), // absent entirely
      goalTypeRow(2, str('SOMETHING_UNEXPECTED')),
    ] });
    const r = await pacingStatusTool.handler({} as never, restCtx(gam)) as Record<string, any>;
    for (const row of r.rows) {
      expect(row.delivery_indicator).toBeNull();
      expect(row.derived.reason).toBe('no lifetime goal');
    }
  });

  it('filters by line_item_ids and order_ids, and the filters reach the report definition', async () => {
    const gam = createFakeGam();
    gam.setRows({ byColumn: [lifetimeRow({ id: 1, indicator: 0.5 })] });
    const r = await pacingStatusTool.handler(
      { date_range: { relative: 'last_7_days' }, line_item_ids: [1, 2], order_ids: [3] } as never,
      restCtx(gam),
    ) as Record<string, any>;
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(1);

    const def = gam.lastDefinition() as { filters?: { fieldFilter: { field: { dimension: string }; values: { intValue: string }[] } }[] };
    const filters = def.filters ?? [];
    expect(filters.map((f) => f.fieldFilter.field.dimension)).toEqual(['LINE_ITEM_ID', 'ORDER_ID']);
    expect(filters[0].fieldFilter.values.map((v) => v.intValue)).toEqual(['1', '2']);
    expect(filters[1].fieldFilter.values.map((v) => v.intValue)).toEqual(['3']);
  });
});
