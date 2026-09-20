import { describe, it, expect } from 'vitest';
import { createRestGamClient } from '../src/gam-client-rest.js';
import { GamHttpError, ReportFilterRejectedError, ResultUnavailableError } from '../src/gam-client.js';
import { createFakeGam, int, dbl, str } from './fake-gam.js';
import { definitionFor } from './helpers.js';
import { definitionHash, reportName } from '../src/report-key.js';

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

    const definition = definitionFor({ dimensions: ['AD_UNIT_NAME'], metrics: ['IMPRESSIONS', 'REVENUE'] }, RANGE);
    const { report } = await client.defineReport(definition);
    expect(report).toBe('networks/1234/reports/1');
    expect(gam.requests.at(-1)).toEqual({
      method: 'POST',
      path: 'networks/1234/reports',
      body: { displayName: reportName(definitionHash(definition)), reportDefinition: definition },
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
    const definition = definitionFor(
      { dimensions: ['AD_UNIT_ID'], metrics: ['AD_REQUESTS'], filters: [{ field: 'AD_UNIT_ID', op: '=', value: 5 }] },
      RANGE,
    );
    const { report } = await client.defineReport(definition);
    const stored = await client.getReport(report);
    expect(stored?.name).toBe(report);
    expect(stored?.displayName).toBe(reportName(definitionHash(definition)));
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
    const { report } = await client.defineReport(definitionFor({ dimensions: ['AD_UNIT_NAME'], metrics: ['IMPRESSIONS'] }, RANGE));
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
    const { report } = await client.defineReport(definitionFor({ dimensions: ['DATE'], metrics: ['IMPRESSIONS'] }, RANGE));
    const { operation } = await client.runReport(report);
    const done = await client.pollOperation(operation);
    if (done.state !== 'done') throw new Error('expected done');
    const page = await client.fetchRows(done.result, { pageSize: 5 });
    expect(page.rows).toEqual([]);
    expect(page.totalRowCount).toBeUndefined();
  });

  it('treats NOT_FOUND or FAILED_PRECONDITION naming the result as an unavailable result', async () => {
    const gam = createFakeGam();
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    const result = 'networks/1234/reports/1/results/1';
    const answer = (status: string, message: string) =>
      gam.inject('GET', /:fetchRows/, { status: 400, body: { error: { code: 400, status, message } } });

    answer('FAILED_PRECONDITION', `Report result ${result} has expired.`);
    await expect(client.fetchRows(result, { pageSize: 5 })).rejects.toBeInstanceOf(ResultUnavailableError);
    answer('NOT_FOUND', 'Requested entity reports/1/results/1 was not found.');
    await expect(client.fetchRows(result, { pageSize: 5 })).rejects.toBeInstanceOf(ResultUnavailableError);

    answer('FAILED_PRECONDITION', 'The report results/12 is still running.');
    await expect(client.fetchRows(result, { pageSize: 5 })).rejects.toBeInstanceOf(GamHttpError);
    answer('INVALID_ARGUMENT', `Invalid page token for ${result}.`);
    await expect(client.fetchRows(result, { pageSize: 5 })).rejects.toMatchObject({
      name: 'GamHttpError', call: 'fetchRows', status: 400, gamStatus: 'INVALID_ARGUMENT',
    });
  });

  it('answers a failed poll with GamHttpError, 429 included', async () => {
    const gam = createFakeGam();
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    gam.inject('GET', /\/operations\//, { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } });
    await expect(client.pollOperation('networks/1234/operations/reports/runs/1')).rejects.toMatchObject({
      name: 'GamHttpError', call: 'pollOperation', status: 429, gamStatus: 'RESOURCE_EXHAUSTED',
    });
  });

  it('reads the network time zone and currency', async () => {
    const gam = createFakeGam();
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    expect(await client.getNetwork()).toEqual({ networkCode: '1234', timeZone: 'Asia/Tokyo', currencyCode: 'USD' });
    expect(gam.requests.at(-1)).toEqual({ method: 'GET', path: 'networks/1234' });
  });

  it('refuses a network answer without a currency', async () => {
    const gam = createFakeGam();
    delete gam.network.currencyCode;
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    await expect(client.getNetwork()).rejects.toThrow('GAM returned no currencyCode');
  });

  it('lists reports by exact display name', async () => {
    const gam = createFakeGam();
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    const a = definitionFor({ dimensions: ['DATE'], metrics: ['IMPRESSIONS'] }, RANGE);
    const b = definitionFor({ dimensions: ['DATE'], metrics: ['IMPRESSIONS'] }, { start: '2026-09-03', end: '2026-09-04' });
    const { report } = await client.defineReport(a);
    await client.defineReport(b);
    const name = reportName(definitionHash(a));
    expect(await client.listReports({ displayName: name })).toEqual([{ name: report, displayName: name, definition: a }]);
    const path = gam.requests.at(-1)!.path;
    expect(path.startsWith('networks/1234/reports?')).toBe(true);
    expect(new URLSearchParams(path.split('?')[1]).get('filter')).toBe(`displayName = "${name}"`);
    expect(await client.listReports({ displayName: 'gam-mcp 0000000000000000' })).toEqual([]);
  });

  it('follows list pages', async () => {
    const gam = createFakeGam();
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    const a = definitionFor({ dimensions: ['DATE'], metrics: ['IMPRESSIONS'] }, RANGE);
    const name = reportName(definitionHash(a));
    const { report } = await client.defineReport(a);
    gam.inject('GET', /^networks\/1234\/reports\?/, {
      status: 200,
      body: {
        reports: [{ name: 'networks/1234/reports/9', displayName: name, reportDefinition: a }],
        nextPageToken: 'p2',
      },
    });
    const listed = await client.listReports({ displayName: name });
    expect(listed.map((r) => r.name)).toEqual(['networks/1234/reports/9', report]);
    expect(new URLSearchParams(gam.requests.at(-1)!.path.split('?')[1]).get('pageToken')).toBe('p2');
  });

  it('reports a refused name filter as ReportFilterRejectedError', async () => {
    const gam = createFakeGam();
    gam.inject('GET', /^networks\/1234\/reports\?/, { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT' } } });
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    await expect(client.listReports({ displayName: 'gam-mcp 0000000000000000' })).rejects.toBeInstanceOf(ReportFilterRejectedError);
  });

  it('reads a stored definition without empty lists as having them', async () => {
    const gam = createFakeGam();
    gam.reports.set('networks/1234/reports/5', {
      name: 'networks/1234/reports/5',
      displayName: 'gam-mcp 0000000000000005',
      reportDefinition: { metrics: ['IMPRESSIONS'], reportType: 'HISTORICAL' },
    });
    const client = createRestGamClient({ networkCode: '1234', fetchImpl: gam.fetch });
    expect((await client.getReport('networks/1234/reports/5'))?.definition)
      .toEqual({ dimensions: [], metrics: ['IMPRESSIONS'], reportType: 'HISTORICAL' });
    expect((await client.listReports({ displayName: 'gam-mcp 0000000000000005' }))[0].definition.dimensions).toEqual([]);
  });
});
