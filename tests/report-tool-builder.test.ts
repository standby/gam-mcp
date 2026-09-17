import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildReportTool } from '../src/report-tool-builder.js';
import { makeCtx } from './helpers.js';

describe('buildReportTool', () => {
  const tool = buildReportTool({
    name: 'top_advertisers_test',
    description: 'Top advertisers by revenue.',
    input: z.object({ date_range: z.object({ start: z.string(), end: z.string() }) }),
    buildQuery: () => ({ dimensions: ['ADVERTISER_NAME'], metrics: ['REVENUE'] }),
    summary: (input) => `Test report ${input.date_range.start}..${input.date_range.end}`,
    warnings: () => ['a caveat'],
  });

  it('runs through executeReport and returns a typed first page', async () => {
    const ctx = makeCtx({ reports: [{
      query: { dimensions: ['ADVERTISER_NAME'], metrics: ['REVENUE'] },
      rows: [{ ADVERTISER_NAME: 'Acme', REVENUE: 5000 }],
    }] });
    const r = await tool.handler({ date_range: { start: '2026-04-01', end: '2026-04-29' } }, ctx);
    expect(r).toMatchObject({
      summary: 'Test report 2026-04-01..2026-04-29',
      total_row_count: 1,
      warnings: ['a caveat'],
      rows: [{ ADVERTISER_NAME: 'Acme', REVENUE: 5000 }],
      provenance: { date_range: { start: '2026-04-01', end: '2026-04-29' } },
    });
    expect(r).not.toHaveProperty('file_path');
  });
});
