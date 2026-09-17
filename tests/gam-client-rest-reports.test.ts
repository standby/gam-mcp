import { describe, it, expect } from 'vitest';
import { createRestGamClient } from '../src/gam-client-rest.js';
import { ResultUnavailableError } from '../src/gam-client.js';
import { createFakeGam, int, dbl, str } from './fake-gam.js';

const RANGE = { start: '2026-09-01', end: '2026-09-02' };

describe('REST client report methods', () => {
  it('defines, runs, polls and fetches pages', async () => {
    const gam = createFakeGam({ completeAfterPolls: 1 });
    gam.setRows([
      { dimensionValues: [str('A')], metricValueGroups: [{ primaryValues: [int(3), dbl(1.5)] }] },
      { dimensionValues: [str('B')], metricValueGroups: [{ primaryValues: [int(2), dbl(0.5)] }] },
      { dimensionValues: [str('C')], metricValueGroups: [{ primaryValues: [int(1), dbl(0.25)] }] },
    ]);
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });

    const { report } = await client.defineReport(
      { dimensions: ['AD_UNIT_NAME'], metrics: ['IMPRESSIONS', 'REVENUE'] }, RANGE,
    );
    expect(report).toBe('networks/1234/reports/1');
    expect(gam.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: 'networks/1234/reports',
      body: { reportDefinition: { dimensions: ['AD_UNIT_NAME'], reportType: 'HISTORICAL' } },
    });

    const { operation } = await client.runReport(report);
    expect(await client.pollOperation(operation)).toEqual({ state: 'running' });
    const done = await client.pollOperation(operation);
    expect(done).toEqual({ state: 'done', result: `${report}/results/1` });

    const result = `${report}/results/1`;
    const p1 = await client.fetchRows(result, { pageSize: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.totalRowCount).toBe(3);
    expect(p1.runTime).toBe('2026-09-03T01:00:00Z');
    expect(p1.dateRanges).toEqual([RANGE]);
    expect(p1.nextPageToken).toBeTruthy();

    const p2 = await client.fetchRows(result, { pageSize: 2, pageToken: p1.nextPageToken });
    expect(p2.rows).toHaveLength(1);
    expect(p2.totalRowCount).toBeUndefined();
    expect(p2.dateRanges).toBeUndefined();
    expect(p2.nextPageToken).toBeUndefined();
    expect(gam.requests.at(-1)?.path).toBe(`${result}:fetchRows?pageSize=2&pageToken=${p1.nextPageToken}`);
  });

  it('throws ResultUnavailableError when GAM no longer serves a result', async () => {
    const gam = createFakeGam();
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    await expect(client.fetchRows('networks/1234/reports/9/results/9', { pageSize: 5 }))
      .rejects.toBeInstanceOf(ResultUnavailableError);
  });

  it('returns a stored report definition, or null for a missing report', async () => {
    const gam = createFakeGam();
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    const { report } = await client.defineReport(
      { dimensions: ['AD_UNIT_ID'], metrics: ['AD_REQUESTS'], filters: [{ field: 'AD_UNIT_ID', op: '=', value: 5 }] },
      RANGE,
    );
    const stored = await client.getReport(report);
    expect(stored?.name).toBe(report);
    expect(stored?.definition.filters).toEqual([
      { fieldFilter: { field: { dimension: 'AD_UNIT_ID' }, operation: 'IN', values: [{ intValue: '5' }] } },
    ]);
    expect(await client.getReport('networks/1234/reports/999')).toBeNull();
  });

  it('omits dateRanges entirely when GAM reports dates with missing parts, rather than empty strings', async () => {
    const gam = createFakeGam({ completeAfterPolls: 1 });
    gam.setRows(
      [{ dimensionValues: [str('A')], metricValueGroups: [{ primaryValues: [int(1)] }] }],
      { dateRanges: [{ startDate: {}, endDate: {} }] },
    );
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    const { report } = await client.defineReport({ dimensions: ['AD_UNIT_NAME'], metrics: ['IMPRESSIONS'] }, RANGE);
    const { operation } = await client.runReport(report);
    await client.pollOperation(operation);
    const done = await client.pollOperation(operation);
    if (done.state !== 'done') throw new Error('expected done');
    const page = await client.fetchRows(done.result, { pageSize: 5 });
    expect(page.dateRanges).toBeUndefined();
  });

  it('omits totalRowCount for an empty first page, as proto3 JSON does', async () => {
    const gam = createFakeGam({ completeAfterPolls: 0 });
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    const { report } = await client.defineReport({ dimensions: ['DATE'], metrics: ['IMPRESSIONS'] }, RANGE);
    const { operation } = await client.runReport(report);
    const done = await client.pollOperation(operation);
    if (done.state !== 'done') throw new Error('expected done');
    const page = await client.fetchRows(done.result, { pageSize: 5 });
    expect(page.rows).toEqual([]);
    expect(page.totalRowCount).toBeUndefined();
  });
});
