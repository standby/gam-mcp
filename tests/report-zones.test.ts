import { describe, it, expect } from 'vitest';
import { derivedEnvelope, executeReport, executeReportRows, fetchReportPage } from '../src/report-exec.js';
import { createRestGamClient } from '../src/gam-client-rest.js';
import { definitionRange, type ReportDefinition } from '../src/report-definition.js';
import { runReportTool } from '../src/tools/run_report.js';
import type { ResultEnvelope } from '../src/envelope.js';
import { createFakeGam, int } from './fake-gam.js';
import { makeCtx, NETWORK, ok } from './helpers.js';

const RANGE = { start: '2026-09-01', end: '2026-09-02' };
const query = { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] };
const request = { tool: 'test', query, dateRange: RANGE, summary: 'S' };
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ AD_UNIT_ID: i + 1, IMPRESSIONS: i }));
const ZONE_WARNING = /GAM_TIMEZONE/;

describe('report time zone and currency (spec §2.4)', () => {
  it('D5: the definition GAM receives runs in the network zone and currency, and provenance says so', async () => {
    const gam = createFakeGam();
    gam.setRows([{ dimensionValues: [int(1)], metricValueGroups: [{ primaryValues: [int(5)] }] }]);
    const client = createRestGamClient({ networkCode: NETWORK, fetchImpl: gam.fetch });
    const r = ok(await executeReport(makeCtx({}, { client }), request));
    const creates = gam.requests.filter((q) => q.method === 'POST' && q.path === `networks/${NETWORK}/reports`);
    expect(creates).toHaveLength(1);
    expect(creates[0].body?.reportDefinition).toMatchObject({ timeZoneSource: 'PUBLISHER', currencyCode: 'USD' });
    expect(creates[0].body?.reportDefinition).not.toHaveProperty('timeZone');
    expect(r.provenance).toMatchObject({ report_time_zone: 'Asia/Tokyo', currency_code: 'USD' });
    expect(Object.keys(r.provenance)).toEqual([
      'network_code', 'report_type', 'report', 'result', 'run_time', 'date_range',
      'report_time_zone', 'date_time_zone', 'currency_code', 'dimensions', 'metrics', 'filters', 'sort', 'cache',
    ]);
  });

  it('D5: a computed result names the zones and the currency too', () => {
    const e = derivedEnvelope(makeCtx(), { summary: 'S', inputs: [], rows: [] });
    expect((e as ResultEnvelope).provenance).toEqual({
      network_code: NETWORK,
      report_time_zone: 'Asia/Tokyo',
      date_time_zone: 'Asia/Tokyo',
      currency_code: 'USD',
      inputs: [],
    });
  });

  it('D6: "yesterday" is chosen in the date time zone, not the network zone', async () => {
    const now = new Date('2026-09-16T16:30:00Z');
    async function yesterdayIn(timezone: string) {
      const ctx = makeCtx({ reports: [{ query, rows: rows(1) }] }, { timezone, now });
      const inner = ctx.client;
      const seen: ReportDefinition[] = [];
      ctx.client = {
        ...inner,
        defineReport: (definition) => { seen.push(definition); return inner.defineReport(definition); },
      };
      const args = runReportTool.input.parse({ ...query, date_range: { relative: 'yesterday' } });
      const r = ok(await runReportTool.handler(args, ctx));
      return { range: definitionRange(seen[0]), provenance: r.provenance };
    }
    const sg = await yesterdayIn('Asia/Seoul');
    expect(sg.range).toEqual({ start: '2026-09-16', end: '2026-09-16' });
    expect(sg.provenance).toMatchObject({ date_time_zone: 'Asia/Seoul', report_time_zone: 'Asia/Tokyo' });
    const utc = await yesterdayIn('UTC');
    expect(utc.range).toEqual({ start: '2026-09-15', end: '2026-09-15' });
    expect(utc.provenance).toMatchObject({ date_time_zone: 'UTC', report_time_zone: 'Asia/Tokyo' });
  });

  it('D4: Asia/Seoul dates against an Asia/Tokyo network carry no zone warning', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(1) }] }, { timezone: 'Asia/Seoul' });
    const r = ok(await executeReport(ctx, request));
    expect(r.provenance).toMatchObject({ date_time_zone: 'Asia/Seoul', report_time_zone: 'Asia/Tokyo' });
    expect(r.warnings.filter((w) => ZONE_WARNING.test(w))).toEqual([]);
  });

  it('D4: America/New_York dates against an Asia/Tokyo network carry one zone warning', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(1) }] }, { timezone: 'America/New_York' });
    const r = ok(await executeReport(ctx, request));
    const zone = r.warnings.filter((w) => ZONE_WARNING.test(w));
    expect(zone).toHaveLength(1);
    expect(zone[0]).toContain('America/New_York');
    expect(zone[0]).toContain('Asia/Tokyo');
    expect(zone[0]).toContain('2026-09-01..2026-09-02');
  });

  it('D4: the warning reaches later pages and tools that compute from rows', async () => {
    const ctx = makeCtx({ reports: [{ query, rows: rows(3) }] }, { timezone: 'America/New_York', pageRows: 2 });
    const first = ok(await executeReport(ctx, request));
    const second = ok(await fetchReportPage(ctx, first.next_cursor!));
    expect(second.warnings.some((w) => ZONE_WARNING.test(w))).toBe(true);
    const computed = await executeReportRows(ctx, query, RANGE, 'test');
    if ('error' in computed) throw new Error(JSON.stringify(computed));
    expect(computed.warnings.some((w) => ZONE_WARNING.test(w))).toBe(true);
  });
});
