import { describe, it, expect, vi } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestGamClient } from '../src/gam-client-rest.js';

describe('REST GAM client', () => {
  it('listEntities GETs the right path and maps fields', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      expect(u).toContain('/networks/12345/orders');
      return new Response(JSON.stringify({
        orders: [
          { orderId: '111', name: 'Order A' },
          { orderId: '222', name: 'Order B' },
        ],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const r = await client.listEntities({ entity_type: 'order' });
    expect(r).toEqual([
      { id: 111, name: 'Order A' },
      { id: 222, name: 'Order B' },
    ]);
  });

  it('createReport POSTs two-step flow with reportDefinition body shape', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      callCount++;
      if (callCount === 1) {
        // Step 1: create report resource
        expect(u).toMatch(/\/networks\/12345\/reports$/);
        const body = JSON.parse(String(init!.body));
        expect(body.reportDefinition.dimensions).toEqual(['ADVERTISER_NAME']);
        expect(body.reportDefinition.metrics).toEqual(['IMPRESSIONS']);
        expect(body.reportDefinition.dateRange.fixed.startDate).toEqual({ year: 2026, month: 4, day: 1 });
        expect(body.reportDefinition.dateRange.fixed.endDate).toEqual({ year: 2026, month: 4, day: 29 });
        expect(body.reportDefinition.reportType).toBe('HISTORICAL');
        return new Response(JSON.stringify({ name: 'networks/12345/reports/789' }), { status: 200 });
      } else {
        // Step 2: run the report
        expect(u).toContain('networks/12345/reports/789:run');
        return new Response(JSON.stringify({ name: 'networks/12345/operations/reports/runs/abc' }), { status: 200 });
      }
    }) as unknown as typeof fetch;

    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const op = await client.createReport(
      { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] },
      { start: '2026-04-01', end: '2026-04-29' },
    );
    expect(op.operation_name).toBe('networks/12345/operations/reports/runs/abc');
    expect(callCount).toBe(2);
  });

  it('createReport encodes filters in GAM REST shape (fieldFilter + EQUALS/IN + scalar/list value)', async () => {
    let createBody: any = null;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/reports')) {
        createBody = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ name: 'networks/12345/reports/1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: 'networks/12345/operations/reports/runs/1' }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    await client.createReport(
      {
        dimensions: ['AD_UNIT_NAME'],
        metrics: ['IMPRESSIONS'],
        filters: [
          { field: 'AD_UNIT_NAME', op: '=', value: 'Foo' },
          { field: 'AD_UNIT_ID', op: 'IN', value: [1, 2, 3] },
          { field: 'COUNTRY_NAME', op: '!=', value: 'XX' },
        ],
      },
      { start: '2026-04-01', end: '2026-04-29' },
    );

    expect(createBody.reportDefinition).not.toHaveProperty('filter');
    // GAM REST shape: field.dimension, operation IN/NOT_IN only, values is
    // always an array of ReportValue, intValue is JSON string (int64).
    expect(createBody.reportDefinition.filters).toEqual([
      { fieldFilter: { field: { dimension: 'AD_UNIT_NAME' }, operation: 'IN',     values: [{ stringValue: 'Foo' }] } },
      { fieldFilter: { field: { dimension: 'AD_UNIT_ID'   }, operation: 'IN',     values: [{ intValue: '1' }, { intValue: '2' }, { intValue: '3' }] } },
      { fieldFilter: { field: { dimension: 'COUNTRY_NAME' }, operation: 'NOT_IN', values: [{ stringValue: 'XX' }] } },
    ]);
  });

  it('createReport omits filters field entirely when none provided', async () => {
    let createBody: any = null;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/reports')) {
        createBody = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ name: 'networks/12345/reports/1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: 'networks/12345/operations/reports/runs/1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    await client.createReport(
      { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] },
      { start: '2026-04-01', end: '2026-04-29' },
    );
    expect(createBody.reportDefinition).not.toHaveProperty('filters');
    expect(createBody.reportDefinition).not.toHaveProperty('filter');
  });

  it('downloadReport fetches rows via fetchRows API and writes gzipped CSV', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const u = String(url);
      if (callCount <= 2) {
        // createReport calls: create + run
        if (callCount === 1) return new Response(JSON.stringify({ name: 'networks/12345/reports/789' }), { status: 200 });
        return new Response(JSON.stringify({ name: 'networks/12345/operations/reports/runs/abc' }), { status: 200 });
      }
      // fetchRows call
      expect(u).toContain('networks/12345/reports/789/results/1:fetchRows');
      return new Response(JSON.stringify({
        rows: [
          {
            dimensionValues: [{ stringValue: 'Google' }],
            metricValueGroups: [{ primaryValues: [{ intValue: 100 }] }],
          },
        ],
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    await client.createReport(
      { dimensions: ['ADVERTISER_NAME'], metrics: ['IMPRESSIONS'] },
      { start: '2026-04-01', end: '2026-04-29' },
    );

    const dest = join(mkdtempSync(join(tmpdir(), 'rest-')), 'out.csv.gz');
    await client.downloadReport('networks/12345/reports/789/results/1', dest);

    const csv = gunzipSync(readFileSync(dest)).toString();
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('ADVERTISER_NAME,IMPRESSIONS');
    expect(lines[1]).toBe('Google,100');
  });

  it('downloadReport falls back to raw HTTP download for HTTP URLs', async () => {
    const csv = 'a,b\n1,2\n';
    const gz = gzipSync(Buffer.from(csv));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://example.invalid/dl');
      return new Response(gz, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }) as unknown as typeof fetch;
    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const dest = join(mkdtempSync(join(tmpdir(), 'rest-')), 'out.csv.gz');
    const path = await client.downloadReport('https://example.invalid/dl', dest);
    expect(readFileSync(path)).toEqual(gz);
  });
});
