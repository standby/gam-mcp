import { describe, it, expect } from 'vitest';
import { kvReportTool } from '../../src/tools/kv_report.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { makeCtx } from '../helpers.js';
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
});
