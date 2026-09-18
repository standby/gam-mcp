import { describe, it, expect } from 'vitest';
import { runReportTool } from '../../src/tools/run_report.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { makeCtx } from '../helpers.js';
import type { GAMClient } from '../../src/gam-client.js';
import type { ReportDefinition } from '../../src/report-definition.js';

describe('run_report', () => {
  it('runs a valid query', async () => {
    const ctx = makeCtx(
      {
        reports: [{
          query: { dimensions: ['ADVERTISER_NAME'], metrics: ['REVENUE'] },
          rows: [{ ADVERTISER_NAME: 'Acme', REVENUE: 1000 }],
        }],
      },
      { timezone: 'America/Los_Angeles', now: new Date('2026-04-30T12:00:00Z') },
    );
    const r = await runReportTool.handler(
      {
        dimensions: ['ADVERTISER_NAME'],
        metrics: ['REVENUE'],
        date_range: { relative: 'last_7_days' as const },
      },
      ctx,
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
  });

  it('rejects unknown dimension', async () => {
    const ctx = makeCtx({}, { timezone: 'America/Los_Angeles', now: new Date('2026-04-30T12:00:00Z') });
    const r = await runReportTool.handler(
      {
        dimensions: ['NOT_A_DIMENSION'],
        metrics: ['REVENUE'],
        date_range: { relative: 'yesterday' as const },
      },
      ctx,
    );
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect((r.error as { code: string }).code).toBe('INVALID_INPUT');
    }
  });

  it('rewrites the CREATIVE_SIZE alias to RENDERED_CREATIVE_SIZE and warns', async () => {
    let captured: ReportDefinition | null = null;
    const mock = createMockGamClient({
      reports: [{
        query: { dimensions: ['AD_UNIT_NAME', 'RENDERED_CREATIVE_SIZE'], metrics: ['AVERAGE_ECPM'] },
        rows: [{ AD_UNIT_NAME: 'Homepage', RENDERED_CREATIVE_SIZE: '300x250', AVERAGE_ECPM: 2.5 }],
      }],
    });
    const client: GAMClient = {
      ...mock,
      defineReport: (definition) => {
        captured = definition;
        return mock.defineReport(definition);
      },
    };

    const r = await runReportTool.handler(
      {
        dimensions: ['AD_UNIT_NAME', 'CREATIVE_SIZE'],
        metrics: ['AVERAGE_ECPM'],
        date_range: { relative: 'last_7_days' as const },
      },
      makeCtx({}, { client, timezone: 'America/Los_Angeles', now: new Date('2026-04-30T12:00:00Z') }),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(captured).not.toBeNull();
    expect(captured!.dimensions).toEqual(['AD_UNIT_NAME', 'RENDERED_CREATIVE_SIZE']);
    expect(r.warnings.some((w) => w.includes('RENDERED_CREATIVE_SIZE'))).toBe(true);
  });

  it('rewrites a filter field spelled the same as its aliased dimension, and warns', async () => {
    let captured: ReportDefinition | null = null;
    const mock = createMockGamClient({
      reports: [{
        query: { dimensions: ['RENDERED_CREATIVE_SIZE'], metrics: ['IMPRESSIONS'] },
        rows: [{ RENDERED_CREATIVE_SIZE: '300x250', IMPRESSIONS: 42 }],
      }],
    });
    const client: GAMClient = {
      ...mock,
      defineReport: (definition) => {
        captured = definition;
        return mock.defineReport(definition);
      },
    };

    const r = await runReportTool.handler(
      {
        dimensions: ['CREATIVE_SIZE'],
        metrics: ['IMPRESSIONS'],
        date_range: { start: '2026-09-01', end: '2026-09-07' },
        filters: [{ field: 'CREATIVE_SIZE', op: '=', value: '300x250' }],
      },
      makeCtx({}, { client, timezone: 'America/Los_Angeles', now: new Date('2026-09-17T04:00:00Z') }),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(captured).not.toBeNull();
    expect(captured!.dimensions).toEqual(['RENDERED_CREATIVE_SIZE']);
    expect(JSON.stringify(captured!.filters)).toContain('RENDERED_CREATIVE_SIZE');
    expect(r.warnings.join(' ')).toMatch(/CREATIVE_SIZE.*RENDERED_CREATIVE_SIZE/);
  });

  it('auto-rewrites KEY_VALUES_NAME filter + AD_REQUESTS to CUSTOM_DIMENSION_0_VALUE', async () => {
    let captured: ReportDefinition | null = null;
    const mock = createMockGamClient({
      entities: { custom_targeting_key: [{ id: 4242, name: 'channel_id', displayName: 'Channel ID' }] },
      reports: [{
        query: { dimensions: ['DATE'], metrics: ['AD_REQUESTS'] },
        rows: [{ DATE: '2026-04-29', AD_REQUESTS: 1000 }],
      }],
    });
    const client: GAMClient = {
      ...mock,
      defineReport: (definition) => {
        captured = definition;
        return mock.defineReport(definition);
      },
    };

    const r = await runReportTool.handler(
      {
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        date_range: { start: '2026-04-01', end: '2026-04-29' },
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'channel_id=479' }],
      },
      makeCtx({}, { client, timezone: 'America/Los_Angeles', now: new Date('2026-04-30T12:00:00Z') }),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(captured).not.toBeNull();
    // Filter is rewritten to CUSTOM_DIMENSION_0_VALUE='479'; the original
    // KEY_VALUES_NAME filter is gone.
    expect(captured!.filters).toEqual([
      { fieldFilter: { field: { dimension: 'CUSTOM_DIMENSION_0_VALUE' }, operation: 'IN', values: [{ stringValue: '479' }] } },
    ]);
    expect(captured!.customDimensionKeyIds).toEqual(['4242']);
    // Caller learns about the rewrite via the envelope warnings array.
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toContain('CUSTOM_DIMENSION_0_VALUE');
  });

  it('surfaces INVALID_INPUT when KEY_VALUES rewrite is needed but the key is unknown', async () => {
    const client: GAMClient = {
      ...createMockGamClient({}), // unresolvable key: no entities configured
      defineReport: async () => { throw new Error('should not be reached'); },
      runReport: async () => { throw new Error('unused'); },
      fetchRows: async () => { throw new Error('unused'); },
    };
    const r = await runReportTool.handler(
      {
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        date_range: { start: '2026-04-01', end: '2026-04-29' },
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'mystery=42' }],
      },
      makeCtx({}, { client, timezone: 'America/Los_Angeles', now: new Date('2026-04-30T12:00:00Z') }),
    );
    if (!('error' in r)) throw new Error('expected error');
    expect((r.error as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('returns the first page with a cursor instead of a file path', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ AD_UNIT_ID: i + 1, IMPRESSIONS: i }));
    const ctx = makeCtx(
      { reports: [{ query: { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] }, rows }] },
      { pageRows: 5, now: new Date('2026-04-30T12:00:00Z') },
    );
    const r = await runReportTool.handler(
      runReportTool.input.parse({
        dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'],
        date_range: { start: '2026-04-01', end: '2026-04-02' },
      }),
      ctx,
    );
    expect(r).toMatchObject({ total_row_count: 7, returned_row_count: 5, truncated: true });
    expect(r).not.toHaveProperty('file_path');
    expect(typeof (r as { next_cursor: unknown }).next_cursor).toBe('string');
  });

  it('refuses to rewrite a key-value filter whose key name matches two keys (spec §3.3)', async () => {
    const ctx = makeCtx({
      entities: { custom_targeting_key: [{ id: 11, name: 'section' }, { id: 12, name: 'section' }] },
      reports: [{ query: { dimensions: ['DATE'], metrics: ['AD_REQUESTS'] }, rows: [] }],
    });
    const r = await runReportTool.handler(
      runReportTool.input.parse({
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        date_range: { start: '2026-09-01', end: '2026-09-07' },
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'section=news' }],
      }),
      ctx,
    );
    expect(r).toMatchObject({
      error: { code: 'AMBIGUOUS_NAME', details: { candidates: [{ id: 11, name: 'section' }, { id: 12, name: 'section' }] } },
    });
  });
});
