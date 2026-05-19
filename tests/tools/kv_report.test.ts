import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kvReportTool } from '../../src/tools/kv_report.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';
import type { GAMClient, ReportQuery, DateRange } from '../../src/gam-client.js';

describe('kv_report', () => {
  it('resolves the key, runs a CUSTOM_DIMENSION report, and surfaces a resolution warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvr-'));
    const csv = 'custom_dimension_0_value,date,ad_requests\n479,2026-05-01,1000\n';
    const csvGz = gzipSync(Buffer.from(csv));
    let captured: { query: ReportQuery; dateRange: DateRange } | null = null;

    const client: GAMClient = {
      async listEntities({ entity_type, query, match }) {
        // kv_report should call listEntities with match='exact' to resolve channel_id.
        if (entity_type === 'custom_targeting_key' && query === 'channel_id') {
          expect(match).toBe('exact');
          return [{ id: 12345, name: 'channel_id', displayName: 'Channel ID' }];
        }
        return [];
      },
      async createReport(query, dateRange) {
        captured = { query, dateRange };
        return { operation_name: 'op/1' };
      },
      async pollOperation() { return { state: 'done', download_url: 'mock://op/1' }; },
      async downloadReport(_url, dest) { writeFileSync(dest, csvGz); return dest; },
    };

    const args = kvReportTool.input.parse({
      kv: 'channel_id=479',
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metrics: ['AD_REQUESTS', 'IMPRESSIONS'],
      dimensions: ['DATE'],
    });
    const r = await kvReportTool.handler(args, {
      client,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
    });
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(captured).not.toBeNull();
    expect(captured!.query.dimensions).toEqual(['CUSTOM_DIMENSION_0_VALUE', 'DATE']);
    expect(captured!.query.metrics).toEqual(['AD_REQUESTS', 'IMPRESSIONS']);
    expect(captured!.query.filters).toEqual([
      { field: 'CUSTOM_DIMENSION_0_VALUE', op: '=', value: '479' },
    ]);
    expect(captured!.query.custom_dimension_key_ids).toEqual([12345]);
    expect(captured!.dateRange).toEqual({ start: '2026-05-01', end: '2026-05-07' });
    expect(r.warnings?.[0]).toContain('channel_id');
    expect(r.warnings?.[0]).toContain('12345');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns ENTITY_NOT_FOUND when the key cannot be resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvr-'));
    const client: GAMClient = {
      async listEntities() { return []; },
      async createReport() { throw new Error('should not be reached'); },
      async pollOperation() { throw new Error('unused'); },
      async downloadReport() { throw new Error('unused'); },
    };
    const args = kvReportTool.input.parse({
      kv: 'mystery=42',
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metrics: ['AD_REQUESTS'],
    });
    const r = await kvReportTool.handler(args, {
      client,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
    });
    if (!('error' in r)) throw new Error('expected ENTITY_NOT_FOUND');
    expect((r.error as { code: string }).code).toBe('ENTITY_NOT_FOUND');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects kv inputs that are not in key=value form (zod schema)', () => {
    expect(() => kvReportTool.input.parse({
      kv: 'no_equals',
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metrics: ['REVENUE'],
    })).toThrow();
  });

  it('narrows by ad_unit_name via exact lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvr-'));
    const csv = 'custom_dimension_0_value,ad_requests\n479,500\n';
    const csvGz = gzipSync(Buffer.from(csv));
    let capturedFilters: ReportQuery['filters'];

    const client: GAMClient = {
      async listEntities({ entity_type, query }) {
        if (entity_type === 'custom_targeting_key' && query === 'channel_id') {
          return [{ id: 12345, name: 'channel_id', displayName: 'Channel ID' }];
        }
        if (entity_type === 'ad_unit' && query === 'homepage_top') {
          return [{ id: 777, name: 'homepage_top', displayName: 'Homepage Top' }];
        }
        return [];
      },
      async createReport(query) { capturedFilters = query.filters; return { operation_name: 'op/1' }; },
      async pollOperation() { return { state: 'done', download_url: 'mock://op/1' }; },
      async downloadReport(_url, dest) { writeFileSync(dest, csvGz); return dest; },
    };

    const args = kvReportTool.input.parse({
      kv: 'channel_id=479',
      ad_unit_name: 'homepage_top',
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metrics: ['AD_REQUESTS'],
    });
    await kvReportTool.handler(args, {
      client,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
    });
    expect(capturedFilters).toEqual([
      { field: 'CUSTOM_DIMENSION_0_VALUE', op: '=', value: '479' },
      { field: 'AD_UNIT_ID', op: '=', value: 777 },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});
