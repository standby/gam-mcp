import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { viewabilityBreakdownTool } from '../../src/tools/viewability_breakdown.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

const METRICS = [
  'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
  'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
  'ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
  'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',
  'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE',
];

describe('viewability_breakdown', () => {
  it('returns viewability metrics by creative size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vw-'));
    const csv =
      'rendered_creative_size,active_view_viewable_impressions,active_view_measurable_impressions,active_view_eligible_impressions,active_view_viewable_impressions_rate,active_view_measurable_impressions_rate\n' +
      '300x250,700000,1000000,1100000,0.7,0.91\n';
    const args = viewabilityBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'size',
    });
    const r = await viewabilityBreakdownTool.handler(args, {
      client: createMockGamClient({
        reports: [{ query: { dimensions: ['RENDERED_CREATIVE_SIZE'], metrics: METRICS }, csvGz: gzipSync(Buffer.from(csv)) }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not emit a duplicate dimension when by and group_by collide', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vw-'));
    const csv =
      'device_category_name,active_view_viewable_impressions,active_view_measurable_impressions,active_view_eligible_impressions,active_view_viewable_impressions_rate,active_view_measurable_impressions_rate\n' +
      'DESKTOP,500000,600000,650000,0.83,0.92\n';
    const args = viewabilityBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'device',
      group_by: 'device',
    });
    // Single DEVICE_CATEGORY_NAME dimension — the collision guard drops the duplicate.
    const r = await viewabilityBreakdownTool.handler(args, {
      client: createMockGamClient({
        reports: [{ query: { dimensions: ['DEVICE_CATEGORY_NAME'], metrics: METRICS }, csvGz: gzipSync(Buffer.from(csv)) }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
