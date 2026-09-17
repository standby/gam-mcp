import { describe, it, expect } from 'vitest';
import { createMockGamClient } from '../src/gam-client.js';
import { definitionFor } from './helpers.js';

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
});

describe('mock client typed report path', () => {
  const query = { dimensions: ['DATE', 'AD_UNIT_ID'], metrics: ['IMPRESSIONS', 'REVENUE'] };
  const range = { start: '2026-09-01', end: '2026-09-02' };
  const fixture = {
    query,
    rows: [
      { DATE: '2026-09-01', AD_UNIT_ID: 5, IMPRESSIONS: 10, REVENUE: 2 },
      { DATE: '2026-09-02', AD_UNIT_ID: 5, IMPRESSIONS: null, REVENUE: 1.25 },
    ],
  };

  it('serves typed rows in definition order, one page at a time', async () => {
    const client = createMockGamClient({ reports: [fixture] });
    const definition = definitionFor(query, range);
    const { report } = await client.defineReport(definition);
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
    expect(p1.dateRanges).toEqual([range]);
    const p2 = await client.fetchRows(done.result, { pageSize: 1, pageToken: p1.nextPageToken });
    expect(p2.rows[0].metricValueGroups?.[0].primaryValues?.[0]).toEqual({});
    expect(p2.nextPageToken).toBeUndefined();
    expect(p2.totalRowCount).toBeUndefined();
    expect(await client.getReport(report)).toEqual({ name: report, definition });
  });

  it("matches a fixture on the definition's dimensions, metrics and fixed range", async () => {
    const client = createMockGamClient({ reports: [{ ...fixture, dateRange: range }] });
    await expect(client.defineReport(definitionFor(query, { start: '2026-08-01', end: '2026-08-02' })))
      .rejects.toThrow('no report fixture matches');
    await expect(client.defineReport(definitionFor(query, range))).resolves.toEqual({ report: 'networks/1234/reports/1' });
  });

  it('can fail or stall a run and expire a result', async () => {
    const client = createMockGamClient({
      reports: [fixture],
      runOutcomes: { 1: 'failed', 2: 'never' },
      expiredResults: ['networks/1234/reports/3/results/3'],
    });
    const define = async () => (await client.defineReport(definitionFor(query, range))).report;
    const a = await client.runReport(await define());
    expect(await client.pollOperation(a.operation)).toEqual({ state: 'failed', reason: 'mock: report failed' });
    const b = await client.runReport(await define());
    await client.pollOperation(b.operation);
    expect(await client.pollOperation(b.operation)).toEqual({ state: 'running' });
    const c = await client.runReport(await define());
    await client.pollOperation(c.operation);
    const done = await client.pollOperation(c.operation);
    if (done.state !== 'done') throw new Error('expected done');
    await expect(client.fetchRows(done.result, { pageSize: 5 })).rejects.toThrow('no longer available');
  });
});

describe('mock client network', () => {
  it('answers getNetwork with Asia/Tokyo and USD unless told otherwise', async () => {
    expect(await createMockGamClient().getNetwork())
      .toEqual({ networkCode: '1234', timeZone: 'Asia/Tokyo', currencyCode: 'USD' });
    expect(await createMockGamClient({ networkCode: '5678', network: { timeZone: 'Europe/Berlin', currencyCode: 'EUR' } }).getNetwork())
      .toEqual({ networkCode: '5678', timeZone: 'Europe/Berlin', currencyCode: 'EUR' });
  });
});
