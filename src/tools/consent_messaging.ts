import { z } from 'zod';
import { buildReportTool } from '../report-tool-builder.js';
import type { ReportQuery } from '../gam-client.js';

// GAM's PRIVACY_AND_MESSAGING report carries several unrelated message
// families. Their metrics are only populated for the family the message
// belongs to, so asking for all 24 at once yields mostly-empty columns —
// callers pick exactly one family via `focus`.
const FOCUS_METRICS = {
  eu_consent: [
    'EUROPEAN_REGULATIONS_MESSAGES_SHOWN',
    'EUROPEAN_REGULATIONS_CONSENT_RATE',
    'EUROPEAN_REGULATIONS_NO_CONSENT_RATE',
    'EUROPEAN_REGULATIONS_CUSTOM_CONSENT_RATE',
  ],
  ad_blocking: [
    'USER_MESSAGES_AD_BLOCKING_RECOVERY_MESSAGES_SHOWN',
    'USER_MESSAGES_AD_BLOCKING_RECOVERY_ALLOWLISTED_COUNT',
    'USER_MESSAGES_ALLOW_ADS_PAGEVIEWS',
    'USER_MESSAGES_AD_BLOCKING_EXTENSION_RATE',
  ],
  att: [
    'USER_MESSAGES_IDFA_ATT_ALERTS_SHOWN',
    'USER_MESSAGES_IDFA_ATT_CONSENT',
    'USER_MESSAGES_IDFA_ATT_CONSENT_RATE',
    'USER_MESSAGES_IDFA_ATT_DECLINE_CONSENT',
    'USER_MESSAGES_IDFA_ATT_DECLINE_RATE',
    'USER_MESSAGES_IDFA_EXPLAINERS_SHOWN',
    'USER_MESSAGES_IDFA_IAB_MESSAGES_SHOWN',
    'USER_MESSAGES_IDFA_NO_DECISION',
  ],
  us_states: [
    'USER_MESSAGES_US_STATES_MESSAGES_SHOWN',
    'USER_MESSAGES_US_STATES_OPT_OUT_SELECTIONS',
  ],
  ads_personalization: [
    'USER_MESSAGES_UPTC_MESSAGES_SHOWN',
    'USER_MESSAGES_UPTC_PERSONALIZATION_OPT_OUT_RATIO',
  ],
  offerwall: [
    'USER_MESSAGES_OFFERWALL_MESSAGES_SHOWN',
    'USER_MESSAGES_OFFERWALL_SUCCESSFUL_ENGAGEMENTS',
    'USER_MESSAGES_POST_OFFERWALL_PAGEVIEWS',
    'USER_MESSAGES_TOTAL_ESTIMATED_REVENUE',
  ],
} as const;

type Focus = keyof typeof FOCUS_METRICS;
const FOCUS_KEYS = Object.keys(FOCUS_METRICS) as [Focus, ...Focus[]];

// Only dimensions the PRIVACY_AND_MESSAGING report type accepts.
const GROUP_BY = {
  none: null,
  day: 'DATE',
  country: 'COUNTRY_NAME',
  device: 'DEVICE_CATEGORY_NAME',
  os_group: 'USER_MESSAGES_OPERATING_SYSTEM_CRITERIA_NAME',
  app: 'MOBILE_APP_NAME',
} as const;

type GroupBy = keyof typeof GROUP_BY;
const GROUP_BY_KEYS = Object.keys(GROUP_BY) as [GroupBy, ...GroupBy[]];

// Surfaced on every result: a message type that is not switched on for the
// network reports as zeros/empty rather than as an error, so an empty result
// is ambiguous on its own.
export const MESSAGING_NOT_CONFIGURED_WARNING =
  'Every message type in this report is optional and independently configured. If the ' +
  'selected focus is not set up (or not serving) on this network, GAM returns zeros or no ' +
  'rows instead of an error — so an all-zero result means "this message type is not ' +
  'configured / not being shown" at least as often as it means "no traffic". Confirm the ' +
  "message type exists in the network's privacy & messaging settings before reading a zero " +
  'as a drop in user activity.';

const RATE_WARNING =
  'Rate metrics are ratios over the messages shown in each row, so they are NOT additive and a ' +
  'plain average across rows is wrong — weight by that row\'s messages-shown count, or re-run ' +
  'at the level you want a single rate for.';

const inputSchema = z.object({
  date_range: z
    .object({
      start: z.string().describe('Inclusive start date, YYYY-MM-DD.'),
      end: z.string().describe('Inclusive end date, YYYY-MM-DD.'),
    })
    .describe('Absolute date range to report over.'),
  focus: z
    .enum(FOCUS_KEYS)
    .describe(
      'Which user-message family to measure. Each family has its own metrics and they cannot ' +
      'be meaningfully combined in one query. ' +
      "'eu_consent': European (GDPR/TCF) regulations messages — messages shown, consent rate, " +
      'no-consent rate, custom-consent rate. ' +
      "'ad_blocking': ad blocking recovery messages — messages shown, allowlist conversions, " +
      'allow-ads page views, ad blocking extension rate. ' +
      "'att': iOS App Tracking Transparency — ATT alerts shown, allow/deny counts and rates, " +
      'IDFA explainers, no-decision count. ' +
      "'us_states': US state regulations messages — messages shown and opt-out selections. " +
      "'ads_personalization': ads personalization control messages — messages shown and " +
      'personalization opt-out ratio. ' +
      "'offerwall': Offerwall messages — messages shown, successful engagements, post-offerwall " +
      'page views, estimated revenue.',
    ),
  group_by: z
    .enum(GROUP_BY_KEYS)
    .default('none')
    .describe(
      "Optional slice. 'none' returns one total row. 'day' trends the family over time; " +
      "'country' separates jurisdictions; 'device' splits by device category; 'os_group' " +
      "splits by operating system group; 'app' splits by mobile app. These are the report " +
      "type's own compatible dimensions — inventory/order/line-item dimensions are not available here.",
    ),
});

export const consentMessagingTool = buildReportTool({
  name: 'consent_messaging',
  description:
    'Privacy and user-messaging performance: how many consent / ad-blocking-recovery / ATT / ' +
    'opt-out messages were shown and how users responded. Use this for "what is our consent rate", ' +
    '"how many users decline tracking", "how many users reject all purposes", "is ad blocking ' +
    'recovery working", "how much addressable inventory are consent choices costing us". ' +
    'Pick one message family with `focus` (their metrics are disjoint and cannot be mixed), and ' +
    'optionally slice by day, country, device, OS group, or app. Each message family is an optional ' +
    'GAM feature: if it is not configured on the network the report comes back zero/empty rather ' +
    'than erroring. Counts and response rates only — this report cannot be joined to impression or ' +
    'revenue metrics.',
  input: inputSchema,
  buildQuery: (input): ReportQuery => {
    const dim = GROUP_BY[input.group_by];
    return {
      dimensions: dim ? [dim] : [],
      metrics: [...FOCUS_METRICS[input.focus]],
      report_type: 'PRIVACY_AND_MESSAGING',
    };
  },
  summary: (input) => {
    const slice = input.group_by === 'none' ? '' : ` by ${input.group_by}`;
    return `User messaging (${input.focus})${slice}, ${input.date_range.start}..${input.date_range.end}`;
  },
  warnings: () => [MESSAGING_NOT_CONFIGURED_WARNING, RATE_WARNING],
});
