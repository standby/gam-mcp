import { describe, it, expect } from 'vitest';
import { createUsageCounters, instrumentGamClient } from '../src/usage.js';
import { createMockGamClient } from '../src/gam-client.js';
import { definitionFor } from './helpers.js';

describe('UsageCounters + instrumentGamClient', () => {
  it('counts list_entities and report-job calls separately', async () => {
    const counters = createUsageCounters();
    const inner = createMockGamClient({
      entities: { ad_unit: [{ id: 1, name: 'a' }] },
      reports: [{ query: { dimensions: ['DATE'], metrics: ['REVENUE'] }, rows: [{ DATE: '2026-04-01', REVENUE: 100 }] }],
    });
    const wrapped = instrumentGamClient(inner, counters);

    await wrapped.listEntities({ entity_type: 'ad_unit', limit: 10 });
    const { report } = await wrapped.defineReport(definitionFor({ dimensions: ['DATE'], metrics: ['REVENUE'] }, { start: '2026-04-01', end: '2026-04-01' }));
    const { operation } = await wrapped.runReport(report);
    await wrapped.pollOperation(operation); // running
    await wrapped.pollOperation(operation); // done

    expect(counters.list_entities_calls).toBe(1);
    expect(counters.report_jobs_created).toBe(1);
    expect(counters.poll_operations).toBe(2);
  });

  it('accumulates report latency across runReport and pollOperation', async () => {
    const counters = createUsageCounters();
    const inner = createMockGamClient({
      reports: [{
        query: { dimensions: ['DATE'], metrics: ['REVENUE'] },
        rows: [{ DATE: '2026-04-01', REVENUE: 100 }],
      }],
    });
    const wrapped = instrumentGamClient(inner, counters);
    const { report } = await wrapped.defineReport(definitionFor({ dimensions: ['DATE'], metrics: ['REVENUE'] }, { start: '2026-04-01', end: '2026-04-01' }));
    await wrapped.runReport(report);
    expect(counters.cumulative_report_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('counts each typed report-path call once', async () => {
    const counters = createUsageCounters();
    const inner = createMockGamClient({
      reports: [{ query: { dimensions: ['DATE'], metrics: ['IMPRESSIONS'] }, rows: [{ DATE: '2026-09-01', IMPRESSIONS: 1 }] }],
    });
    const wrapped = instrumentGamClient(inner, counters);

    const { report } = await wrapped.defineReport(definitionFor({ dimensions: ['DATE'], metrics: ['IMPRESSIONS'] }, { start: '2026-09-01', end: '2026-09-01' }));
    const { operation } = await wrapped.runReport(report);
    await wrapped.pollOperation(operation); // running
    const done = await wrapped.pollOperation(operation); // done
    if (done.state !== 'done') throw new Error('expected done');
    await wrapped.fetchRows(done.result, { pageSize: 10 });
    await wrapped.getReport(report);

    expect(counters.report_definitions_created).toBe(1);
    expect(counters.report_jobs_created).toBe(1);
    expect(counters.report_pages_fetched).toBe(1);
    expect(counters.report_lookups).toBe(1);
  });

  it('counts a report listing as a report lookup', async () => {
    const counters = createUsageCounters();
    const wrapped = instrumentGamClient(createMockGamClient(), counters);
    await wrapped.listReports({ displayName: 'gam-mcp 0000000000000000' });
    expect(counters.report_lookups).toBe(1);
  });
});
