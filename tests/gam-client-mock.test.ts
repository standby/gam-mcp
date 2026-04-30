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
