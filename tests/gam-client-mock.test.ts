import { describe, it, expect } from 'vitest';
import { createMockGamClient, type ReportFixture } from '../src/gam-client.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

describe('mock GAM client', () => {
  it('returns canned entities for listEntities', async () => {
    const client = createMockGamClient({
      entities: {
        advertiser: [{ id: 1, name: 'Acme Corp' }, { id: 2, name: 'Beta Inc' }],
      },
    });
    const r = await client.listEntities({ entity_type: 'advertiser', query: 'acme' });
    expect(r).toEqual([{ id: 1, name: 'Acme Corp' }]);
  });

  it('returns ambiguous matches case-insensitively', async () => {
    const client = createMockGamClient({
      entities: {
        advertiser: [{ id: 1, name: 'Acme Corp' }, { id: 2, name: 'Acme Industries' }],
      },
    });
    const r = await client.listEntities({ entity_type: 'advertiser', query: 'acme' });
    expect(r).toHaveLength(2);
  });

  it('runs a fake report job: poll returns running, then done, then download', async () => {
    const csv = 'advertiser_name,revenue\nAcme,123\n';
    const fixture: ReportFixture = {
      query: { dimensions: ['ADVERTISER_NAME'], metrics: ['TOTAL_REVENUE'] },
      csvGz: gzipSync(Buffer.from(csv)),
    };
    const client = createMockGamClient({ reports: [fixture] });
    const op = await client.createReport(fixture.query, { start: '2026-04-01', end: '2026-04-29' });
    const first = await client.pollOperation(op.operation_name);
    expect(first.state).toBe('running');
    const second = await client.pollOperation(op.operation_name);
    expect(second.state).toBe('done');
    if (second.state !== 'done') throw new Error('unreachable');
    const path = await client.downloadReport(second.download_url, '/tmp/test-out.csv.gz');
    expect(readFileSync(path)).toEqual(fixture.csvGz);
  });
});

describe('mock client typed report path', () => {
  const query = { dimensions: ['DATE', 'AD_UNIT_ID'], metrics: ['IMPRESSIONS', 'REVENUE'] };
  const fixture = {
    query,
    rows: [
      { DATE: '2026-09-01', AD_UNIT_ID: 5, IMPRESSIONS: 10, REVENUE: 2 },
      { DATE: '2026-09-02', AD_UNIT_ID: 5, IMPRESSIONS: null, REVENUE: 1.25 },
    ],
  };

  it('serves typed rows in definition order, one page at a time', async () => {
    const client = createMockGamClient({ reports: [fixture] });
    const { report } = await client.defineReport(query, { start: '2026-09-01', end: '2026-09-02' });
    const { operation } = await client.runReport(report);
    expect((await client.pollOperation(operation)).state).toBe('running');
    const done = await client.pollOperation(operation);
    if (done.state !== 'done') throw new Error('expected done');
    const p1 = await client.fetchRows(done.result, { pageSize: 1 });
    expect(p1.rows).toEqual([{
      dimensionValues: [{ intValue: '20260901' }, { intValue: '5' }],
      metricValueGroups: [{ primaryValues: [{ intValue: '10' }, { doubleValue: 2 }] }],
    }]);
    expect(p1.totalRowCount).toBe(2);
    expect(p1.dateRanges).toEqual([{ start: '2026-09-01', end: '2026-09-02' }]);
    const p2 = await client.fetchRows(done.result, { pageSize: 1, pageToken: p1.nextPageToken });
    expect(p2.rows[0].metricValueGroups?.[0].primaryValues?.[0]).toEqual({});
    expect(p2.nextPageToken).toBeUndefined();
    expect(p2.totalRowCount).toBeUndefined();
    expect((await client.getReport(report))?.definition.dimensions).toEqual(['DATE', 'AD_UNIT_ID']);
  });

  it('can fail or stall a run and expire a result', async () => {
    const client = createMockGamClient({
      reports: [fixture],
      runOutcomes: { 1: 'failed', 2: 'never' },
      expiredResults: ['networks/1234/reports/3/results/3'],
    });
    const range = { start: '2026-09-01', end: '2026-09-02' };
    const a = await client.runReport((await client.defineReport(query, range)).report);
    expect(await client.pollOperation(a.operation)).toEqual({ state: 'failed', reason: 'mock: report failed' });
    const b = await client.runReport((await client.defineReport(query, range)).report);
    await client.pollOperation(b.operation);
    expect(await client.pollOperation(b.operation)).toEqual({ state: 'running' });
    const c = await client.runReport((await client.defineReport(query, range)).report);
    await client.pollOperation(c.operation);
    const done = await client.pollOperation(c.operation);
    if (done.state !== 'done') throw new Error('expected done');
    await expect(client.fetchRows(done.result, { pageSize: 5 })).rejects.toThrow('no longer available');
  });
});
