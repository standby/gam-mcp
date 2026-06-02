import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { videoBreakdownTool } from '../../src/tools/video_breakdown.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';

const METRICS = [
  'VIDEO_VIEWERSHIP_STARTS',
  'VIDEO_VIEWERSHIP_FIRST_QUARTILES',
  'VIDEO_VIEWERSHIP_MIDPOINTS',
  'VIDEO_VIEWERSHIP_THIRD_QUARTILES',
  'VIDEO_VIEWERSHIP_COMPLETES',
  'VIDEO_VIEWERSHIP_COMPLETION_RATE',
];

describe('video_breakdown', () => {
  it('returns the completion funnel by ad unit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vid-'));
    const csv =
      'ad_unit_name,video_viewership_starts,video_viewership_first_quartiles,video_viewership_midpoints,video_viewership_third_quartiles,video_viewership_completes,video_viewership_completion_rate\n' +
      'Homepage,100000,90000,80000,70000,60000,0.6\n';
    const args = videoBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
    });
    const r = await videoBreakdownTool.handler(args, {
      client: createMockGamClient({
        reports: [{ query: { dimensions: ['AD_UNIT_NAME'], metrics: METRICS }, csvGz: gzipSync(Buffer.from(csv)) }],
      }),
      output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
      timezone: 'UTC',
      logger: noopLogger(),
    });
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.row_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('slices by placement type with a secondary dimension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vid-'));
    const csv =
      'video_plcmt_name,date,video_viewership_starts,video_viewership_first_quartiles,video_viewership_midpoints,video_viewership_third_quartiles,video_viewership_completes,video_viewership_completion_rate\n' +
      'In-stream,2026-04-01,50000,45000,40000,35000,30000,0.6\n';
    const args = videoBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-01' },
      by: 'placement',
      group_by: 'day',
    });
    const r = await videoBreakdownTool.handler(args, {
      client: createMockGamClient({
        reports: [{ query: { dimensions: ['VIDEO_PLCMT_NAME', 'DATE'], metrics: METRICS }, csvGz: gzipSync(Buffer.from(csv)) }],
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
