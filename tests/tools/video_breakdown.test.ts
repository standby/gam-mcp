import { describe, it, expect } from 'vitest';
import { videoBreakdownTool } from '../../src/tools/video_breakdown.js';
import { makeCtx } from '../helpers.js';

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
    const args = videoBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
    });
    const r = await videoBreakdownTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: { dimensions: ['AD_UNIT_NAME'], metrics: METRICS },
          rows: [{
            AD_UNIT_NAME: 'Homepage',
            VIDEO_VIEWERSHIP_STARTS: 100000,
            VIDEO_VIEWERSHIP_FIRST_QUARTILES: 90000,
            VIDEO_VIEWERSHIP_MIDPOINTS: 80000,
            VIDEO_VIEWERSHIP_THIRD_QUARTILES: 70000,
            VIDEO_VIEWERSHIP_COMPLETES: 60000,
            VIDEO_VIEWERSHIP_COMPLETION_RATE: 0.6,
          }],
        }] },
        { timezone: 'UTC' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
  });

  it('slices by placement type with a secondary dimension', async () => {
    const args = videoBreakdownTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-01' },
      by: 'placement',
      group_by: 'day',
    });
    const r = await videoBreakdownTool.handler(
      args,
      makeCtx(
        { reports: [{
          query: { dimensions: ['VIDEO_PLCMT_NAME', 'DATE'], metrics: METRICS },
          rows: [{
            VIDEO_PLCMT_NAME: 'In-stream',
            DATE: '2026-04-01',
            VIDEO_VIEWERSHIP_STARTS: 50000,
            VIDEO_VIEWERSHIP_FIRST_QUARTILES: 45000,
            VIDEO_VIEWERSHIP_MIDPOINTS: 40000,
            VIDEO_VIEWERSHIP_THIRD_QUARTILES: 35000,
            VIDEO_VIEWERSHIP_COMPLETES: 30000,
            VIDEO_VIEWERSHIP_COMPLETION_RATE: 0.6,
          }],
        }] },
        { timezone: 'UTC' },
      ),
    );
    if ('error' in r) throw new Error(JSON.stringify(r));
    expect(r.total_row_count).toBe(1);
  });
});
