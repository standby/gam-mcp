import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kvBreakdownTool } from '../../src/tools/kv_breakdown.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';
import type { GAMClient, ReportQuery, DateRange } from '../../src/gam-client.js';

describe('kv_breakdown', () => {
  it('queries CUSTOM_DIMENSION_0_VALUE with the chosen metric', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvb-'));
    const csv = 'custom_dimension_0_value,revenue\nsports,1234\nnews,5678\n';
    const args = kvBreakdownTool.input.parse({
      custom_targeting_key_id: 999,
      date_range: { start: '2026-04-01', end: '2026-04-29' },
      metric: 'revenue',
      top_n: 10,
    });
    const r = await kvBreakdownTool.handler(args, {
      client: createMockGamClient({
        reports: [{
          query: { dimensions: ['CUSTOM_DIMENSION_0_VALUE'], metrics: ['REVENUE'] },
          csvGz: gzipSync(Buffer.from(csv)),
        }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
    });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  // Stronger check: the mock client's fixture matcher ignores filters and
  // custom_dimension_key_ids, but those are the load-bearing parts of this
  // tool — a regression that drops the key-id wire-up would still pass the
  // basic mock test above. Capture the raw query/dateRange that hits the
  // client and assert their exact shape.
  it('wires custom_dimension_key_ids[0] = key and applies entity filters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvb-'));
    let captured: { query: ReportQuery; dateRange: DateRange } | null = null;
    const csv = 'custom_dimension_0_value,impressions\nsports,1000\n';
    const csvGz = gzipSync(Buffer.from(csv));

    const spyClient: GAMClient = {
      async listEntities() { return []; },
      async createReport(query, dateRange) {
        captured = { query, dateRange };
        return { operation_name: 'op/1' };
      },
      async pollOperation() {
        return { state: 'done', download_url: 'mock://op/1' };
      },
      async downloadReport(_url, dest) {
        writeFileSync(dest, csvGz);
        return dest;
      },
    };

    const args = kvBreakdownTool.input.parse({
      custom_targeting_key_id: 4242,
      date_range: { start: '2026-05-01', end: '2026-05-07' },
      metric: 'impressions',
      ad_unit_id: 77,
      order_id: 88,
    });
    const r = await kvBreakdownTool.handler(args, {
      client: spyClient,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
    });
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(captured).not.toBeNull();
    expect(captured!.query.dimensions).toEqual(['CUSTOM_DIMENSION_0_VALUE']);
    expect(captured!.query.metrics).toEqual(['IMPRESSIONS']);
    expect(captured!.query.custom_dimension_key_ids).toEqual([4242]);
    expect(captured!.query.filters).toEqual([
      { field: 'AD_UNIT_ID', op: '=', value: 77 },
      { field: 'ORDER_ID', op: '=', value: 88 },
    ]);
    expect(captured!.dateRange).toEqual({ start: '2026-05-01', end: '2026-05-07' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('omits filters when no entity narrowing is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvb-'));
    let captured: ReportQuery | null = null;
    const csvGz = gzipSync(Buffer.from('custom_dimension_0_value,revenue\nsports,1\n'));
    const spyClient: GAMClient = {
      async listEntities() { return []; },
      async createReport(query) { captured = query; return { operation_name: 'op/1' }; },
      async pollOperation() { return { state: 'done', download_url: 'mock://op/1' }; },
      async downloadReport(_url, dest) { writeFileSync(dest, csvGz); return dest; },
    };
    const args = kvBreakdownTool.input.parse({
      custom_targeting_key_id: 1,
      date_range: { start: '2026-05-01', end: '2026-05-07' },
    });
    await kvBreakdownTool.handler(args, {
      client: spyClient,
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'America/Los_Angeles',
      logger: noopLogger(),
    });
    expect(captured!.filters).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
