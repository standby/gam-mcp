import { describe, it, expect } from 'vitest';
import { kvReportTool } from '../../src/tools/kv_report.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { counted, makeCtx, ok } from '../helpers.js';
import type { GAMClient } from '../../src/gam-client.js';
import { definitionRange, type ReportDefinition } from '../../src/report-definition.js';

describe('kv_report', () => {
  it('resolves the key, runs a CUSTOM_DIMENSION report, and surfaces a resolution warning', async () => {
    let captured: ReportDefinition | null = null;
    const mock = createMockGamClient({
      entities: { custom_targeting_key: [{ id: 12345, name: 'channel_id', displayName: 'Channel ID' }] },
      reports: [{
        query: { dimensions: ['CUSTOM_DIMENSION_0_VALUE', 'DATE'], metrics: ['AD_REQUESTS', 'IMPRESSIONS'] },
        rows: [{ CUSTOM_DIMENSION_0_VALUE: '479', DATE: '2026-05-01', AD_REQUESTS: 1000, IMPRESSIONS: 5000 }],
      }],
    });
    const client: GAMClient = {
      ...mock,
      // kv_report should call listEntities with match='exact' to resolve channel_id.
      async listEntities(q) {
        if (q.entity_type === 'custom_targeting_key' && q.query === 'channel_id') {
          expect(q.match).toBe('exact');
        }
        return mock.listEntities(q);
      },
      defineReport: (definition) => {
        captured = definition;
        return mock.defineReport(definition);
      },
    };

    const args = kvReportTool.input.parse({
      kv: 'channel_id=479',
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metrics: ['AD_REQUESTS', 'IMPRESSIONS'],
      dimensions: ['DATE'],
    });
    const r = await kvReportTool.handler(args, makeCtx({}, { client, timezone: 'America/Los_Angeles' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(captured).not.toBeNull();
    expect(captured!.dimensions).toEqual(['CUSTOM_DIMENSION_0_VALUE', 'DATE']);
    expect(captured!.metrics).toEqual(['AD_REQUESTS', 'IMPRESSIONS']);
    expect(captured!.filters).toEqual([
      { fieldFilter: { field: { dimension: 'CUSTOM_DIMENSION_0_VALUE' }, operation: 'IN', values: [{ stringValue: '479' }] } },
    ]);
    expect(captured!.customDimensionKeyIds).toEqual(['12345']);
    expect(definitionRange(captured!)).toEqual({ start: '2026-05-01', end: '2026-05-07' });
    expect(r.warnings[0]).toContain('channel_id');
    expect(r.warnings[0]).toContain('12345');
  });

  it('returns ENTITY_NOT_FOUND when the key cannot be resolved', async () => {
    const client: GAMClient = {
      ...createMockGamClient({}), // unresolvable
      defineReport: async () => { throw new Error('should not be reached'); },
      runReport: async () => { throw new Error('unused'); },
      fetchRows: async () => { throw new Error('unused'); },
    };
    const args = kvReportTool.input.parse({
      kv: 'mystery=42',
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metrics: ['AD_REQUESTS'],
    });
    const r = await kvReportTool.handler(args, makeCtx({}, { client, timezone: 'America/Los_Angeles' }));
    if (!('error' in r)) throw new Error('expected ENTITY_NOT_FOUND');
    expect((r.error as { code: string }).code).toBe('ENTITY_NOT_FOUND');
  });

  it('rejects kv inputs that are not in key=value form (zod schema)', () => {
    expect(() => kvReportTool.input.parse({
      kv: 'no_equals',
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metrics: ['REVENUE'],
    })).toThrow();
  });

  it('narrows by ad_unit_name via exact lookup', async () => {
    let capturedFilters: unknown[] | undefined;
    const mock = createMockGamClient({
      entities: {
        custom_targeting_key: [{ id: 12345, name: 'channel_id', displayName: 'Channel ID' }],
        ad_unit: [{ id: 777, name: 'homepage_top', displayName: 'Homepage Top' }],
      },
      reports: [{
        query: { dimensions: ['CUSTOM_DIMENSION_0_VALUE'], metrics: ['AD_REQUESTS'] },
        rows: [{ CUSTOM_DIMENSION_0_VALUE: '479', AD_REQUESTS: 500 }],
      }],
    });
    const client: GAMClient = {
      ...mock,
      defineReport: (definition) => {
        capturedFilters = definition.filters;
        return mock.defineReport(definition);
      },
    };

    const args = kvReportTool.input.parse({
      kv: 'channel_id=479',
      ad_unit_name: 'homepage_top',
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metrics: ['AD_REQUESTS'],
    });
    await kvReportTool.handler(args, makeCtx({}, { client, timezone: 'America/Los_Angeles' }));
    expect(capturedFilters).toEqual([
      { fieldFilter: { field: { dimension: 'CUSTOM_DIMENSION_0_VALUE' }, operation: 'IN', values: [{ stringValue: '479' }] } },
      { fieldFilter: { field: { dimension: 'AD_UNIT_ID' }, operation: 'IN', values: [{ intValue: '777' }] } },
    ]);
  });

  // report-exec.ts's pageEnvelope appends a generic "(filtered by ...)"
  // clause to every report summary (spec §4.7). kv_report's own summary
  // already names its filters in friendlier terms (the human key name, not
  // CUSTOM_DIMENSION_0_VALUE) -- without describesFilters this tool doubled
  // up, e.g. "kv_report (kv=..., ad_unit=...) ... (filtered by
  // CUSTOM_DIMENSION_0_VALUE = ..., AD_UNIT_ID = ...)": two adjacent groups
  // describing the same filters twice, the exact anti-pattern top_line_items
  // was fixed for in this same task.
  it('summary names its filters once, not twice (regression: adjacent parentheticals)', async () => {
    const mock = createMockGamClient({
      entities: {
        custom_targeting_key: [{ id: 12345, name: 'channel_id', displayName: 'Channel ID' }],
        ad_unit: [{ id: 777, name: 'homepage_top', displayName: 'Homepage Top' }],
      },
      reports: [{
        query: { dimensions: ['CUSTOM_DIMENSION_0_VALUE'], metrics: ['AD_REQUESTS'] },
        rows: [{ CUSTOM_DIMENSION_0_VALUE: '479', AD_REQUESTS: 500 }],
      }],
    });
    const args = kvReportTool.input.parse({
      kv: 'channel_id=479',
      ad_unit_name: 'homepage_top',
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metrics: ['AD_REQUESTS'],
    });
    const r = await kvReportTool.handler(args, makeCtx({}, { client: mock, timezone: 'America/Los_Angeles' }));
    if ('error' in r) throw new Error(JSON.stringify(r));
    // Exactly one parenthetical group in the whole summary.
    expect(r.summary.match(/\(/g)?.length).toBe(1);
    expect(r.summary).toContain('kv=channel_id=479');
    expect(r.summary).toContain('ad_unit=777');
    expect(r.summary).not.toMatch(/filtered by/);
  });

  it('resolves a relative range in the date zone (GAM_TIMEZONE), not the network report zone', async () => {
    const mock = createMockGamClient({
      entities: { custom_targeting_key: [{ id: 777, name: 'section' }] },
      reports: [{
        query: { dimensions: ['CUSTOM_DIMENSION_0_VALUE'], metrics: ['IMPRESSIONS'] },
        rows: [{ CUSTOM_DIMENSION_0_VALUE: 'news', IMPRESSIONS: 10 }],
      }],
    });
    const args = kvReportTool.input.parse({
      kv: 'section=news',
      date_range: { relative: 'yesterday' },
      metrics: ['IMPRESSIONS'],
    });
    // Pacific/Kiritimati (UTC+14) and Etc/GMT+12 (UTC-12) are two fixed-offset
    // (no DST) zones 26 hours apart, picked only so "yesterday" falls on a
    // different calendar day in each -- not because either has any bearing on
    // a real publisher's configuration. GAM_TIMEZONE (ctx.timezone) is meant
    // to pick the date; the network's own zone (ctx.reportTimeZone) is only
    // what rows are counted in and must not decide "yesterday".
    const ctx = makeCtx({}, {
      client: mock,
      timezone: 'Pacific/Kiritimati',
      reportTimeZone: 'Etc/GMT+12',
      now: new Date('2026-09-17T18:00:00Z'),
    });
    const r = ok(await kvReportTool.handler(args, ctx));
    // Pacific/Kiritimati's "yesterday" for this instant is 2026-09-17;
    // Etc/GMT+12's is 2026-09-16 -- a wrong implementation using the report
    // zone would resolve to the latter.
    expect(r.provenance.date_range).toEqual({ start: '2026-09-17', end: '2026-09-17' });
  });

  describe('names that match more than one entity (spec §3.3)', () => {
    const range = { start: '2026-05-01', end: '2026-05-07' };
    const query = { dimensions: ['CUSTOM_DIMENSION_0_VALUE'], metrics: ['AD_REQUESTS'] };

    it('I11: an ambiguous key name is AMBIGUOUS_NAME with the candidates, and no report runs', async () => {
      const { ctx, counters } = counted({
        entities: {
          custom_targeting_key: [
            { id: 11, name: 'section', displayName: 'Section' },
            { id: 12, name: 'section', displayName: 'Section (old)' },
          ],
        },
        reports: [{ query, rows: [] }],
      });
      const r = await kvReportTool.handler(
        kvReportTool.input.parse({ kv: 'section=news', date_range: range, metrics: ['AD_REQUESTS'] }),
        ctx,
      );
      expect(r).toMatchObject({
        error: {
          code: 'AMBIGUOUS_NAME',
          details: {
            candidates: [
              { id: 11, name: 'section', displayName: 'Section' },
              { id: 12, name: 'section', displayName: 'Section (old)' },
            ],
          },
        },
      });
      expect(counters.report_definitions_created).toBe(0);
    });

    it('an ad_unit_name shared by two ad units is AMBIGUOUS_NAME, not the first unit', async () => {
      const { ctx, counters } = counted({
        entities: {
          custom_targeting_key: [{ id: 11, name: 'section' }],
          ad_unit: [{ id: 701, name: 'Top banner' }, { id: 702, name: 'Top banner' }],
        },
        reports: [{ query, rows: [] }],
      });
      const r = await kvReportTool.handler(
        kvReportTool.input.parse({ kv: 'section=news', ad_unit_name: 'Top banner', date_range: range, metrics: ['AD_REQUESTS'] }),
        ctx,
      );
      expect(r).toMatchObject({
        error: {
          code: 'AMBIGUOUS_NAME',
          hint: 'Pick an ad unit from details.candidates and pass its ID as ad_unit_id.',
          details: { entity_type: 'ad_unit', candidates: [{ id: 701, name: 'Top banner' }, { id: 702, name: 'Top banner' }] },
        },
      });
      expect(counters.report_definitions_created).toBe(0);
    });
  });
});
