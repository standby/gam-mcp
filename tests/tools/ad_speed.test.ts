import { describe, it, expect } from 'vitest';
import { adSpeedTool } from '../../src/tools/ad_speed.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { makeCtx, NETWORK } from '../helpers.js';
import type { ReportDefinition } from '../../src/report-definition.js';

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

// Wraps the mock so the query the tool actually sent can be asserted on —
// the mock only matches dimensions/metrics as sets and ignores report_type.
function capturing(mock: ReturnType<typeof createMockGamClient>) {
  const seen: { definition?: ReportDefinition } = {};
  return {
    seen,
    client: {
      ...mock,
      defineReport: (definition: ReportDefinition) => {
        seen.definition = definition;
        return mock.defineReport(definition);
      },
    },
  };
}

describe('ad_speed', () => {
  it('requests the creative load buckets by ad unit under reportType AD_SPEED', async () => {
    const { seen, client } = capturing(
      createMockGamClient({
        networkCode: NETWORK,
        reports: [{
          query: { dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'], metrics: CREATIVE_LOAD },
          rows: [{
            AD_UNIT_ID: 1,
            AD_UNIT_NAME: 'Homepage',
            IMPRESSIONS: 1000000,
            CREATIVE_LOAD_TIME_0_500_PERCENT: 0.42,
            CREATIVE_LOAD_TIME_500_1000_PERCENT: 0.31,
            CREATIVE_LOAD_TIME_1000_2000_PERCENT: 0.15,
            CREATIVE_LOAD_TIME_2000_4000_PERCENT: 0.07,
            CREATIVE_LOAD_TIME_4000_8000_PERCENT: 0.03,
            CREATIVE_LOAD_TIME_GT_8000_PERCENT: 0.02,
          }],
        }],
      }),
    );

    const args = adSpeedTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'ad_unit',
      focus: 'creative_load',
    });
    const r = await adSpeedTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.definition?.reportType).toBe('AD_SPEED');
    expect(seen.definition?.dimensions).toEqual(['AD_UNIT_ID', 'AD_UNIT_NAME']);
    expect(seen.definition?.metrics).toEqual(CREATIVE_LOAD);
    expect(r.total_row_count).toBe(1);
    expect(r.rows[0]?.CREATIVE_LOAD_TIME_GT_8000_PERCENT).toBe(0.02);
  });

  it('returns the full pre-request funnel for focus page_timing', async () => {
    const row: Record<string, number | string> = { DEVICE_CATEGORY_NAME: 'DESKTOP', IMPRESSIONS: 500000 };
    for (const m of PAGE_TIMING) if (m !== 'IMPRESSIONS') row[m] = 0.1;
    const { seen, client } = capturing(
      createMockGamClient({
        networkCode: NETWORK,
        reports: [{
          query: { dimensions: ['DEVICE_CATEGORY_NAME'], metrics: PAGE_TIMING },
          rows: [row],
        }],
      }),
    );

    const args = adSpeedTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'device',
      focus: 'page_timing',
    });
    const r = await adSpeedTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.definition?.reportType).toBe('AD_SPEED');
    // All three funnel stages, or the caller cannot tell a late tag from a slow one.
    expect(seen.definition?.metrics).toEqual(PAGE_TIMING);
    expect(seen.definition?.metrics).toContain('DOM_LOAD_TO_TAG_LOAD_TIME_GT_8000_PERCENT');
    expect(seen.definition?.metrics).toContain('TAG_LOAD_TO_FIRST_AD_REQUEST_0_500_PERCENT');
    expect(r.total_row_count).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/funnel/i);
  });

  it('returns the unviewed reason split for focus unviewed_reason', async () => {
    const { seen, client } = capturing(
      createMockGamClient({
        networkCode: NETWORK,
        reports: [{
          query: { dimensions: ['COUNTRY_NAME'], metrics: UNVIEWED_REASON },
          rows: [{
            COUNTRY_NAME: 'Japan',
            IMPRESSIONS: 250000,
            UNVIEWED_REASON_USER_SCROLLED_BEFORE_AD_FILLED_PERCENT: 0.30,
            UNVIEWED_REASON_USER_SCROLLED_BEFORE_AD_LOADED_PERCENT: 0.25,
            UNVIEWED_REASON_USER_SCROLLED_BEFORE_ONE_SECOND_PERCENT: 0.20,
            UNVIEWED_REASON_SLOT_NEVER_ENTERED_VIEWPORT_PERCENT: 0.20,
            UNVIEWED_REASON_OTHER_PERCENT: 0.05,
          }],
        }],
      }),
    );

    const args = adSpeedTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'country',
      focus: 'unviewed_reason',
    });
    const r = await adSpeedTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.definition?.reportType).toBe('AD_SPEED');
    expect(seen.definition?.metrics).toEqual(UNVIEWED_REASON);
    expect(r.rows[0]?.UNVIEWED_REASON_SLOT_NEVER_ENTERED_VIEWPORT_PERCENT).toBe(0.20);
  });

  it('warns that the buckets are a distribution rather than counts', async () => {
    const { client } = capturing(
      createMockGamClient({
        networkCode: NETWORK,
        reports: [{
          query: { dimensions: ['RENDERED_CREATIVE_SIZE'], metrics: CREATIVE_LOAD },
          rows: [{
            RENDERED_CREATIVE_SIZE: '300x250',
            IMPRESSIONS: 900000,
            CREATIVE_LOAD_TIME_0_500_PERCENT: 0.5,
            CREATIVE_LOAD_TIME_500_1000_PERCENT: 0.2,
            CREATIVE_LOAD_TIME_1000_2000_PERCENT: 0.15,
            CREATIVE_LOAD_TIME_2000_4000_PERCENT: 0.1,
            CREATIVE_LOAD_TIME_4000_8000_PERCENT: 0.03,
            CREATIVE_LOAD_TIME_GT_8000_PERCENT: 0.02,
          }],
        }],
      }),
    );

    const args = adSpeedTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-07' },
      by: 'creative_size',
    });
    const r = await adSpeedTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    const warnings = r.warnings.join(' ');
    expect(warnings).toMatch(/sum to ~100%/i);
    expect(warnings).toMatch(/never sum buckets/i);
    // creative_load is the default focus, so no page-timing caveat here.
    expect(warnings).not.toMatch(/funnel/i);
  });
});
