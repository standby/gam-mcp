import { describe, it, expect } from 'vitest';
import { reachReportTool } from '../../src/tools/reach_report.js';
import { runReportTool } from '../../src/tools/run_report.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { makeCtx, NETWORK } from '../helpers.js';
import { resolveReportType, GAM_SCHEMA } from '../../src/schema.js';
import type { ReportDefinition } from '../../src/report-definition.js';

const METRICS = ['UNIQUE_VISITORS', 'REACH_IMPRESSIONS', 'AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR'];

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
    const mock = createMockGamClient({
      networkCode: NETWORK,
      reports: [{
        query: { dimensions: ['LINE_ITEM_ID', 'LINE_ITEM_NAME'], metrics: METRICS },
        rows: [{
          LINE_ITEM_ID: 111,
          LINE_ITEM_NAME: 'Brand Campaign',
          UNIQUE_VISITORS: 250000,
          REACH_IMPRESSIONS: 1000000,
          AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR: 4.0,
        }],
      }],
    });
    let seen: ReportDefinition | undefined;
    const client = {
      ...mock,
      defineReport: (definition: ReportDefinition) => {
        seen = definition;
        return mock.defineReport(definition);
      },
    };

    const args = reachReportTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-30' },
      by: 'line_item',
    });
    const r = await reachReportTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen?.reportType).toBe('REACH');
    expect(seen?.metrics).toEqual(METRICS);
    expect(r.rows[0]?.AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR).toBe(4.0);
    expect(r.warnings.join(' ')).toMatch(/NOT additive/i);
  });

  it('filters on the primary id dimension when ids are given', async () => {
    const mock = createMockGamClient({
      networkCode: NETWORK,
      reports: [{
        query: { dimensions: ['ORDER_ID', 'ORDER_NAME', 'COUNTRY_NAME'], metrics: METRICS },
        rows: [{
          ORDER_ID: 7,
          ORDER_NAME: 'Q2 Direct',
          COUNTRY_NAME: 'Japan',
          UNIQUE_VISITORS: 50000,
          REACH_IMPRESSIONS: 150000,
          AVERAGE_IMPRESSIONS_PER_UNIQUE_VISITOR: 3.0,
        }],
      }],
    });
    let seen: ReportDefinition | undefined;
    const client = {
      ...mock,
      defineReport: (definition: ReportDefinition) => {
        seen = definition;
        return mock.defineReport(definition);
      },
    };

    const args = reachReportTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-30' },
      by: 'order',
      group_by: 'country',
      ids: [7],
    });
    const r = await reachReportTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen?.filters).toEqual([
      { fieldFilter: { field: { dimension: 'ORDER_ID' }, operation: 'IN', values: [{ intValue: '7' }] } },
    ]);
    expect(seen?.dimensions).toEqual(['ORDER_ID', 'ORDER_NAME', 'COUNTRY_NAME']);
  });
});

describe('run_report with reach metrics', () => {
  it('sets report_type REACH and attaches the dedup warning', async () => {
    let seen: ReportDefinition | undefined;
    const mock = createMockGamClient({
      reports: [{
        query: { dimensions: ['LINE_ITEM_NAME'], metrics: ['UNIQUE_VISITORS'] },
        rows: [{ LINE_ITEM_NAME: 'Brand Campaign', UNIQUE_VISITORS: 250000 }],
      }],
    });
    const client = {
      ...mock,
      defineReport: (definition: ReportDefinition) => {
        seen = definition;
        return mock.defineReport(definition);
      },
    };

    const args = runReportTool.input.parse({
      dimensions: ['LINE_ITEM_NAME'],
      metrics: ['UNIQUE_VISITORS'],
      date_range: { start: '2026-04-01', end: '2026-04-30' },
    });
    const r = await runReportTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen?.reportType).toBe('REACH');
    expect(r.warnings.join(' ')).toMatch(/NOT additive/i);
  });

  it('rejects mixing reach and historical metrics instead of letting GAM 400', async () => {
    const args = runReportTool.input.parse({
      dimensions: ['LINE_ITEM_NAME'],
      metrics: ['UNIQUE_VISITORS', 'IMPRESSIONS'],
      date_range: { start: '2026-04-01', end: '2026-04-30' },
    });
    const r = await runReportTool.handler(args, makeCtx({}, { timezone: 'UTC' }));
    expect('error' in r).toBe(true);
    // The message must name which side wants which type — "incompatible"
    // alone doesn't tell the caller what to drop.
    expect(JSON.stringify(r)).toContain('UNIQUE_VISITORS → REACH');
    expect(JSON.stringify(r)).toContain('separate type');
  });
});
