import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reachReportTool } from '../../src/tools/reach_report.js';
import { runReportTool } from '../../src/tools/run_report.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';
import { resolveReportType, GAM_SCHEMA } from '../../src/schema.js';
import type { ReportQuery } from '../../src/gam-client.js';

const METRICS = ['UNIQUE_VISITORS', 'REACH_IMPRESSIONS', 'AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR'];

const ctx = (dir: string, client: ReturnType<typeof createMockGamClient>) => ({
  client,
  output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
  timezone: 'UTC',
  logger: noopLogger(),
});

// The SOAP API names these UNIQUE_REACH / UNIQUE_REACH_IMPRESSIONS /
// UNIQUE_REACH_FREQUENCY; REST does not. Whitelisting a SOAP spelling makes
// run_report accept a query GAM will reject, which only shows up against the
// live API — so pin the REST names here.
describe('reach metric names match the REST enum, not SOAP', () => {
  it('whitelists the REST spellings and none of the SOAP ones', () => {
    const names = GAM_SCHEMA.metrics.map((m) => m.name);
    for (const n of METRICS) expect(names).toContain(n);
    for (const soap of ['UNIQUE_REACH', 'UNIQUE_REACH_IMPRESSIONS', 'UNIQUE_REACH_FREQUENCY']) {
      expect(names).not.toContain(soap);
    }
  });
});

describe('resolveReportType', () => {
  it('defaults to HISTORICAL', () => {
    expect(resolveReportType(['IMPRESSIONS', 'REVENUE'])).toBe('HISTORICAL');
  });

  it('switches to REACH for an all-reach metric list', () => {
    expect(resolveReportType(METRICS)).toBe('REACH');
  });

  it('rejects a mixed list naming both sides', () => {
    const r = resolveReportType(['UNIQUE_VISITORS', 'IMPRESSIONS']);
    expect(typeof r).toBe('object');
    const { error } = r as { error: string };
    expect(error).toContain('UNIQUE_VISITORS');
    expect(error).toContain('IMPRESSIONS');
  });
});

describe('reach_report', () => {
  it('requests the reach metrics under reportType REACH and warns about dedup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reach-'));
    let seen: ReportQuery | undefined;
    const mock = createMockGamClient({
      reports: [{
        query: { dimensions: ['LINE_ITEM_ID', 'LINE_ITEM_NAME'], metrics: METRICS },
        csvGz: gzipSync(Buffer.from(
          'line_item_id,line_item_name,unique_visitors,reach_impressions,average_impressions_per_unique_visitor\n' +
          '111,Brand Campaign,250000,1000000,4.0\n',
        )),
      }],
    });
    const client = {
      ...mock,
      createReport: (q: ReportQuery, dr: { start: string; end: string }) => {
        seen = q;
        return mock.createReport(q, dr);
      },
    };

    const args = reachReportTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-30' },
      by: 'line_item',
    });
    const r = await reachReportTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen?.report_type).toBe('REACH');
    expect(seen?.metrics).toEqual(METRICS);
    expect(r.rows?.[0].average_impressions_per_unique_visitor).toBe('4.0');
    expect(r.warnings?.join(' ')).toMatch(/NOT additive/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters on the primary id dimension when ids are given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reach-'));
    let seen: ReportQuery | undefined;
    const mock = createMockGamClient({
      reports: [{
        query: { dimensions: ['ORDER_ID', 'ORDER_NAME', 'COUNTRY_NAME'], metrics: METRICS },
        csvGz: gzipSync(Buffer.from(
          'order_id,order_name,country_name,unique_visitors,reach_impressions,average_impressions_per_unique_visitor\n' +
          '7,Q2 Direct,Japan,50000,150000,3.0\n',
        )),
      }],
    });
    const client = {
      ...mock,
      createReport: (q: ReportQuery, dr: { start: string; end: string }) => {
        seen = q;
        return mock.createReport(q, dr);
      },
    };

    const args = reachReportTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-30' },
      by: 'order',
      group_by: 'country',
      ids: [7],
    });
    const r = await reachReportTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen?.filters).toEqual([{ field: 'ORDER_ID', op: 'IN', value: [7] }]);
    expect(seen?.dimensions).toEqual(['ORDER_ID', 'ORDER_NAME', 'COUNTRY_NAME']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('run_report with reach metrics', () => {
  it('sets report_type REACH and attaches the dedup warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reach-'));
    let seen: ReportQuery | undefined;
    const mock = createMockGamClient({
      reports: [{
        query: { dimensions: ['LINE_ITEM_NAME'], metrics: ['UNIQUE_VISITORS'] },
        csvGz: gzipSync(Buffer.from('line_item_name,unique_visitors\nBrand Campaign,250000\n')),
      }],
    });
    const client = {
      ...mock,
      createReport: (q: ReportQuery, dr: { start: string; end: string }) => {
        seen = q;
        return mock.createReport(q, dr);
      },
    };

    const args = runReportTool.input.parse({
      dimensions: ['LINE_ITEM_NAME'],
      metrics: ['UNIQUE_VISITORS'],
      date_range: { start: '2026-04-01', end: '2026-04-30' },
    });
    const r = await runReportTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen?.report_type).toBe('REACH');
    expect(r.warnings?.join(' ')).toMatch(/NOT additive/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects mixing reach and historical metrics instead of letting GAM 400', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reach-'));
    const args = runReportTool.input.parse({
      dimensions: ['LINE_ITEM_NAME'],
      metrics: ['UNIQUE_VISITORS', 'IMPRESSIONS'],
      date_range: { start: '2026-04-01', end: '2026-04-30' },
    });
    const r = await runReportTool.handler(args, ctx(dir, createMockGamClient({})));
    expect('error' in r).toBe(true);
    // The message must name which side wants which type — "incompatible"
    // alone doesn't tell the caller what to drop.
    expect(JSON.stringify(r)).toContain('UNIQUE_VISITORS → REACH');
    expect(JSON.stringify(r)).toContain('separate type');
    rmSync(dir, { recursive: true, force: true });
  });
});
