import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReportTool } from '../../src/tools/run_report.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';
import type { GAMClient, ReportQuery } from '../../src/gam-client.js';

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-'));
  const csv = 'advertiser_name,revenue\nAcme,1000\n';
  return {
    dir,
    ctx: {
      client: createMockGamClient({
        reports: [{
          query: { dimensions: ['ADVERTISER_NAME'], metrics: ['REVENUE'] },
          csvGz: gzipSync(Buffer.from(csv)),
        }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
      now: new Date('2026-04-30T12:00:00Z'),
    },
  };
};

describe('run_report', () => {
  it('runs a valid query', async () => {
    const { ctx, dir } = setup();
    const r = await runReportTool.handler(
      {
        dimensions: ['ADVERTISER_NAME'],
        metrics: ['REVENUE'],
        date_range: { relative: 'last_7_days' as const },
      },
      ctx,
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unknown dimension', async () => {
    const { ctx, dir } = setup();
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
    rmSync(dir, { recursive: true, force: true });
  });

  it('auto-rewrites KEY_VALUES_NAME filter + AD_REQUESTS to CUSTOM_DIMENSION_0_VALUE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-'));
    const csv = 'date,ad_requests\n2026-04-29,1000\n';
    const csvGz = gzipSync(Buffer.from(csv));
    let captured: ReportQuery | null = null;

    const client: GAMClient = {
      async listEntities({ entity_type, query }) {
        if (entity_type === 'custom_targeting_key' && query === 'channel_id') {
          return [{ id: 4242, name: 'channel_id', displayName: 'Channel ID' }];
        }
        return [];
      },
      async createReport(query) { captured = query; return { operation_name: 'op/1' }; },
      async pollOperation() { return { state: 'done', download_url: 'mock://op/1' }; },
      async downloadReport(_url, dest) { writeFileSync(dest, csvGz); return dest; },
    };

    const r = await runReportTool.handler(
      {
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        date_range: { start: '2026-04-01', end: '2026-04-29' },
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'channel_id=479' }],
      },
      {
        client,
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: 'America/Los_Angeles',
        logger: noopLogger(),
        now: new Date('2026-04-30T12:00:00Z'),
      },
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(captured).not.toBeNull();
    // Filter is rewritten to CUSTOM_DIMENSION_0_VALUE='479'; the original
    // KEY_VALUES_NAME filter is gone.
    expect(captured!.filters).toEqual([
      { field: 'CUSTOM_DIMENSION_0_VALUE', op: '=', value: '479' },
    ]);
    expect(captured!.custom_dimension_key_ids).toEqual([4242]);
    // Caller learns about the rewrite via the envelope warnings array.
    expect(r.warnings?.length).toBeGreaterThan(0);
    expect(r.warnings![0]).toContain('CUSTOM_DIMENSION_0_VALUE');
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces INVALID_INPUT when KEY_VALUES rewrite is needed but the key is unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-'));
    const client: GAMClient = {
      async listEntities() { return []; }, // unresolvable
      async createReport() { throw new Error('should not be reached'); },
      async pollOperation() { throw new Error('unused'); },
      async downloadReport() { throw new Error('unused'); },
    };
    const r = await runReportTool.handler(
      {
        dimensions: ['DATE'],
        metrics: ['AD_REQUESTS'],
        date_range: { start: '2026-04-01', end: '2026-04-29' },
        filters: [{ field: 'KEY_VALUES_NAME', op: '=', value: 'mystery=42' }],
      },
      {
        client,
        output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
        timezone: 'America/Los_Angeles',
        logger: noopLogger(),
        now: new Date('2026-04-30T12:00:00Z'),
      },
    );
    if (!('error' in r)) throw new Error('expected error');
    expect((r.error as { code: string }).code).toBe('INVALID_INPUT');
    rmSync(dir, { recursive: true, force: true });
  });
});
