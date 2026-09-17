import { describe, it, expect } from 'vitest';
import { consentMessagingTool } from '../../src/tools/consent_messaging.js';
import { createMockGamClient } from '../../src/gam-client.js';
import { makeCtx, NETWORK } from '../helpers.js';
import { GAM_SCHEMA } from '../../src/schema.js';
import type { ReportDefinition } from '../../src/report-definition.js';

const EU_METRICS = [
  'EUROPEAN_REGULATIONS_MESSAGES_SHOWN',
  'EUROPEAN_REGULATIONS_CONSENT_RATE',
  'EUROPEAN_REGULATIONS_NO_CONSENT_RATE',
  'EUROPEAN_REGULATIONS_CUSTOM_CONSENT_RATE',
];

const AD_BLOCKING_METRICS = [
  'USER_MESSAGES_AD_BLOCKING_RECOVERY_MESSAGES_SHOWN',
  'USER_MESSAGES_AD_BLOCKING_RECOVERY_ALLOWLISTED_COUNT',
  'USER_MESSAGES_ALLOW_ADS_PAGEVIEWS',
  'USER_MESSAGES_AD_BLOCKING_EXTENSION_RATE',
];

const ATT_METRICS = [
  'USER_MESSAGES_IDFA_ATT_ALERTS_SHOWN',
  'USER_MESSAGES_IDFA_ATT_CONSENT',
  'USER_MESSAGES_IDFA_ATT_CONSENT_RATE',
  'USER_MESSAGES_IDFA_ATT_DECLINE_CONSENT',
  'USER_MESSAGES_IDFA_ATT_DECLINE_RATE',
  'USER_MESSAGES_IDFA_EXPLAINERS_SHOWN',
  'USER_MESSAGES_IDFA_IAB_MESSAGES_SHOWN',
  'USER_MESSAGES_IDFA_NO_DECISION',
];

// Capture the query the tool hands to the client so the report type and the
// per-focus metric set can be asserted directly.
const spyClient = (mock: ReturnType<typeof createMockGamClient>) => {
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
};

describe('consent_messaging metric names exist in the schema', () => {
  it('whitelists every metric the tool can request', () => {
    const names = GAM_SCHEMA.metrics.map((m) => m.name);
    for (const n of [...EU_METRICS, ...AD_BLOCKING_METRICS, ...ATT_METRICS]) {
      expect(names).toContain(n);
    }
  });
});

describe('consent_messaging', () => {
  it('requests the EU consent metrics under reportType PRIVACY_AND_MESSAGING', async () => {
    const mock = createMockGamClient({
      networkCode: NETWORK,
      reports: [{
        query: { dimensions: ['COUNTRY_NAME'], metrics: EU_METRICS },
        rows: [
          { COUNTRY_NAME: 'Country A', EUROPEAN_REGULATIONS_MESSAGES_SHOWN: 120000, EUROPEAN_REGULATIONS_CONSENT_RATE: 0.71, EUROPEAN_REGULATIONS_NO_CONSENT_RATE: 0.19, EUROPEAN_REGULATIONS_CUSTOM_CONSENT_RATE: 0.10 },
          { COUNTRY_NAME: 'Country B', EUROPEAN_REGULATIONS_MESSAGES_SHOWN: 80000, EUROPEAN_REGULATIONS_CONSENT_RATE: 0.64, EUROPEAN_REGULATIONS_NO_CONSENT_RATE: 0.28, EUROPEAN_REGULATIONS_CUSTOM_CONSENT_RATE: 0.08 },
        ],
      }],
    });
    const { seen, client } = spyClient(mock);

    const args = consentMessagingTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-30' },
      focus: 'eu_consent',
      group_by: 'country',
    });
    const r = await consentMessagingTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    expect(seen.definition?.reportType).toBe('PRIVACY_AND_MESSAGING');
    expect(seen.definition?.metrics).toEqual(EU_METRICS);
    expect(seen.definition?.dimensions).toEqual(['COUNTRY_NAME']);
    expect(r.total_row_count).toBe(2);
    expect(r.rows[0]?.EUROPEAN_REGULATIONS_CONSENT_RATE).toBe(0.71);
  });

  it('swaps the metric set per focus and never mixes families', async () => {
    const cases: [string, string[]][] = [
      ['ad_blocking', AD_BLOCKING_METRICS],
      ['att', ATT_METRICS],
    ];
    for (const [focus, metrics] of cases) {
      const mock = createMockGamClient({
        networkCode: NETWORK,
        reports: [{
          query: { dimensions: [], metrics },
          rows: [Object.fromEntries(metrics.map((m) => [m, 0]))],
        }],
      });
      const { seen, client } = spyClient(mock);

      const args = consentMessagingTool.input.parse({
        date_range: { start: '2026-04-01', end: '2026-04-30' },
        focus,
      });
      const r = await consentMessagingTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
      if ('error' in r) throw new Error(JSON.stringify(r));

      expect(seen.definition?.reportType).toBe('PRIVACY_AND_MESSAGING');
      expect(seen.definition?.metrics).toEqual(metrics);
      // group_by defaults to 'none' — a single total row, no dimensions.
      expect(seen.definition?.dimensions).toEqual([]);
      expect(seen.definition?.metrics.some((m) => EU_METRICS.includes(m))).toBe(false);
    }
  });

  it('warns that an all-zero result may mean the message type is not configured', async () => {
    const client = createMockGamClient({
      networkCode: NETWORK,
      reports: [{
        query: { dimensions: ['DATE'], metrics: ATT_METRICS },
        rows: [{ DATE: '2026-04-01', ...Object.fromEntries(ATT_METRICS.map((m) => [m, 0])) }],
      }],
    });

    const args = consentMessagingTool.input.parse({
      date_range: { start: '2026-04-01', end: '2026-04-01' },
      focus: 'att',
      group_by: 'day',
    });
    const r = await consentMessagingTool.handler(args, makeCtx({}, { client, timezone: 'UTC' }));
    if ('error' in r) throw new Error(JSON.stringify(r));

    const warnings = r.warnings.join(' ');
    expect(warnings).toMatch(/not configured/i);
    expect(warnings).toMatch(/zero/i);
    // The caveat must stay feature-agnostic — it may not assume which message
    // types this publisher runs.
    expect(warnings).toMatch(/NOT additive/i);
  });
});
