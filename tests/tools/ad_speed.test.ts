import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adSpeedTool } from '../../src/tools/ad_speed.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { createOutputManager } from '../../src/output.js';
import { noopLogger } from '../../src/log.js';
import type { ReportQuery } from '../../src/gam-client.js';

const BUCKETS = ['0_500', '500_1000', '1000_2000', '2000_4000', '4000_8000', 'GT_8000'];
const family = (f: string) => BUCKETS.map((b) => `${f}_${b}_PERCENT`);

const CREATIVE_LOAD = ['IMPRESSIONS', ...family('CREATIVE_LOAD_TIME')];
const PAGE_TIMING = [
  'IMPRESSIONS',
  ...family('DOM_LOAD_TO_FIRST_AD_REQUEST'),
  ...family('DOM_LOAD_TO_TAG_LOAD_TIME'),
  ...family('TAG_LOAD_TO_FIRST_AD_REQUEST'),
];
const UNVIEWED_REASON = [
  'IMPRESSIONS',
  'UNVIEWED_REASON_USER_SCROLLED_BEFORE_AD_FILLED_PERCENT',
  'UNVIEWED_REASON_USER_SCROLLED_BEFORE_AD_LOADED_PERCENT',
  'UNVIEWED_REASON_USER_SCROLLED_BEFORE_ONE_SECOND_PERCENT',
  'UNVIEWED_REASON_SLOT_NEVER_ENTERED_VIEWPORT_PERCENT',
  'UNVIEWED_REASON_OTHER_PERCENT',
];

const ctx = (dir: string, client: ReturnType<typeof createMockGamClient>) => ({
  client,
  output: createOutputManager({ tempDir: dir, inlineThreshold: 200 }),
  timezone: 'UTC',
  logger: noopLogger(),
});

// Wraps the mock so the query the tool actually sent can be asserted on —
// the mock only matches dimensions/metrics as sets and ignores report_type.
function capturing(mock: ReturnType<typeof createMockGamClient>) {
  const seen: { query?: ReportQuery } = {};
  return {
    seen,
    client: {
      ...mock,
      createReport: (q: ReportQuery, dr: { start: string; end: string }) => {
        seen.query = q;
        return mock.createReport(q, dr);
      },
    },
  };
}

const csvFor = (header: string, row: string) => gzipSync(Buffer.from(`${header}\n${row}\n`));

describe('ad_speed', () => {
  it('requests the creative load buckets by ad unit under reportType AD_SPEED', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adspeed-'));
    const { seen, client } = capturing(
      createMockGamClient({
        reports: [{
          query: { dimensions: ['AD_UNIT_NAME'], metrics: CREATIVE_LOAD },
          csvGz: csvFor(
            'ad_unit_name,impressions,creative_load_time_0_500_percent,creative_load_time_500_1000_percent,' +
            'creative_load_time_1000_2000_percent,creative_load_time_2000_4000_percent,' +
            'creative_load_time_4000_8000_percent,creative_load_time_gt_8000_percent',
            'Homepage,1000000,0.42,0.31,0.15,0.07,0.03,0.02',
          ),
        }],
      }),
    );

    const args = adSpeedTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'ad_unit',
      focus: 'creative_load',
    });
    const r = await adSpeedTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.query?.report_type).toBe('AD_SPEED');
    expect(seen.query?.dimensions).toEqual(['AD_UNIT_NAME']);
    expect(seen.query?.metrics).toEqual(CREATIVE_LOAD);
    expect(r.row_count).toBe(1);
    expect(r.rows?.[0].creative_load_time_gt_8000_percent).toBe('0.02');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the full pre-request funnel for focus page_timing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adspeed-'));
    const cols = [
      'device_category_name',
      ...PAGE_TIMING.map((m) => m.toLowerCase()),
    ];
    const { seen, client } = capturing(
      createMockGamClient({
        reports: [{
          query: { dimensions: ['DEVICE_CATEGORY_NAME'], metrics: PAGE_TIMING },
          csvGz: csvFor(cols.join(','), ['DESKTOP', '500000', ...Array(18).fill('0.1')].join(',')),
        }],
      }),
    );

    const args = adSpeedTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'device',
      focus: 'page_timing',
    });
    const r = await adSpeedTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.query?.report_type).toBe('AD_SPEED');
    // All three funnel stages, or the caller cannot tell a late tag from a slow one.
    expect(seen.query?.metrics).toEqual(PAGE_TIMING);
    expect(seen.query?.metrics).toContain('DOM_LOAD_TO_TAG_LOAD_TIME_GT_8000_PERCENT');
    expect(seen.query?.metrics).toContain('TAG_LOAD_TO_FIRST_AD_REQUEST_0_500_PERCENT');
    expect(r.row_count).toBe(1);
    expect(r.warnings?.join(' ')).toMatch(/funnel/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the unviewed reason split for focus unviewed_reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adspeed-'));
    const cols = ['country_name', ...UNVIEWED_REASON.map((m) => m.toLowerCase())];
    const { seen, client } = capturing(
      createMockGamClient({
        reports: [{
          query: { dimensions: ['COUNTRY_NAME'], metrics: UNVIEWED_REASON },
          csvGz: csvFor(cols.join(','), 'Japan,250000,0.30,0.25,0.20,0.20,0.05'),
        }],
      }),
    );

    const args = adSpeedTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'country',
      focus: 'unviewed_reason',
    });
    const r = await adSpeedTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.query?.report_type).toBe('AD_SPEED');
    expect(seen.query?.metrics).toEqual(UNVIEWED_REASON);
    expect(r.rows?.[0].unviewed_reason_slot_never_entered_viewport_percent).toBe('0.20');
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns that the buckets are a distribution rather than counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adspeed-'));
    const cols = ['rendered_creative_size', ...CREATIVE_LOAD.map((m) => m.toLowerCase())];
    const { client } = capturing(
      createMockGamClient({
        reports: [{
          query: { dimensions: ['RENDERED_CREATIVE_SIZE'], metrics: CREATIVE_LOAD },
          csvGz: csvFor(cols.join(','), '300x250,900000,0.5,0.2,0.15,0.1,0.03,0.02'),
        }],
      }),
    );

    const args = adSpeedTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'creative_size',
    });
    const r = await adSpeedTool.handler(args, ctx(dir, client));
    if ('error' in r) throw new Error(JSON.stringify(r));

    const warnings = r.warnings?.join(' ') ?? '';
    expect(warnings).toMatch(/sum to ~100%/i);
    expect(warnings).toMatch(/never sum buckets/i);
    // creative_load is the default focus, so no page-timing caveat here.
    expect(warnings).not.toMatch(/funnel/i);
    rmSync(dir, { recursive: true, force: true });
  });
});
