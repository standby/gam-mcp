import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { buildReportTool } from '../src/report-tool-builder.js';
import { createMockGamClient } from '../src/gam-client.js';
import { createOutputManager } from '../src/output.js';
import { noopLogger } from '../src/log.js';

describe('buildReportTool', () => {
  it('runs a fixed-dimensions report and returns the standard envelope', async () => {
    const csv = 'advertiser_name,total_line_item_level_revenue\nAcme,5000\n';
    const client = createMockGamClient({
      reports: [{
        query: { dimensions: ['ADVERTISER_NAME'], metrics: ['TOTAL_LINE_ITEM_LEVEL_REVENUE'] },
        csvGz: gzipSync(Buffer.from(csv)),
      }],
    });
    const dir = mkdtempSync(join(tmpdir(), 'rtb-'));
    const output = createOutputManager({ tempDir: dir, inlineThreshold: 200 });

    const tool = buildReportTool({
      name: 'top_advertisers_test',
      description: 'Top advertisers by revenue.',
      input: z.object({
        date_range: z.object({ start: z.string(), end: z.string() }),
      }),
      buildQuery: () => ({
        dimensions: ['ADVERTISER_NAME'],
        metrics: ['TOTAL_LINE_ITEM_LEVEL_REVENUE'],
      }),
      summary: (input) => `Test report ${input.date_range.start}..${input.date_range.end}`,
    });

    const result = await tool.handler(
      { date_range: { start: '2026-04-01', end: '2026-04-29' } },
      { client, output, timezone: 'America/Los_Angeles', logger: noopLogger(), now: new Date('2026-04-30T12:00:00Z') },
    );

    expect(result.row_count).toBe(1);
    expect(result.rows).toEqual([
      { advertiser_name: 'Acme', total_line_item_level_revenue: '5000' },
    ]);
    expect(result.summary).toMatch(/2026-04-01..2026-04-29/);

    rmSync(dir, { recursive: true, force: true });
  });
});
