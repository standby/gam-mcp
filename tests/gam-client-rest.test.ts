import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
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

  it('createReport POSTs body with dims + metrics + dateRange', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      expect(body.report.dimensions).toEqual(['ADVERTISER_NAME']);
      expect(body.report.metrics).toEqual(['TOTAL_LINE_ITEM_LEVEL_REVENUE']);
      expect(body.report.dateRange).toEqual({ startDate: '2026-04-01', endDate: '2026-04-29' });
      return new Response(JSON.stringify({ name: 'operations/abc' }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createRestGamClient({ networkCode: '12345', fetchImpl });
    const op = await client.createReport(
      { dimensions: ['ADVERTISER_NAME'], metrics: ['TOTAL_LINE_ITEM_LEVEL_REVENUE'] },
      { start: '2026-04-01', end: '2026-04-29' },
    );
    expect(op.operation_name).toBe('operations/abc');
  });

  it('downloadReport streams a URL to a file path', async () => {
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
