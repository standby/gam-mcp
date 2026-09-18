// One row per registered tool: arguments that parse, and that succeed
// against toolWorld(). The guard tests (H1, H2, H3, H5, key order) iterate
// the tools the server registers and look each one up here, so a tool added
// without a row fails them rather than being skipped.
import type { ReportFixture } from '../src/gam-client.js';
import { definitionRange } from '../src/report-definition.js';
import type { ToolContext } from '../src/report-tool-builder.js';
import type { SavedQueryEntry, SavedQueryStore } from '../src/saved-queries.js';
import { createUsageCounters } from '../src/usage.js';
import { encodeCursor } from '../src/cursor.js';
import { makeCtx, NETWORK } from './helpers.js';
import { SAVED_QUERY_TOOLS as SAVED_QUERY_TOOL_DEFS } from '../src/tools/saved_queries.js';

// makeCtx's clock: 2026-09-17 in Asia/Tokyo.
const PAST = { start: '2026-09-01', end: '2026-09-07' };
const FUTURE = { start: '2026-09-21', end: '2026-09-27' };

export const VALID_ARGS: Record<string, Record<string, unknown>> = {
  lookup: { entity_type: 'ad_unit', query: 'home', limit: 10, match: 'substring' },
  describe_schema: { kind: 'metric', search: 'impressions', limit: 5 },
  describe_line_item: { ids: [1] },
  run_report: {
    dimensions: ['AD_UNIT_ID'],
    metrics: ['IMPRESSIONS'],
    date_range: PAST,
    filters: [{ field: 'AD_UNIT_ID', op: 'IN', value: [1] }],
  },
  fetch_report_page: {
    cursor: encodeCursor({
      result: `networks/${NETWORK}/reports/1/results/1`,
      page_token: '1',
      offset: 1,
      total_row_count: 2,
      run_time: null,
      date_range: null,
    }),
  },
  revenue_summary: { date_range: PAST, group_by: 'day' },
  top_advertisers: { date_range: PAST, top_n: 5, metric: 'revenue' },
  top_line_items: { date_range: PAST, top_n: 5, metric: 'impressions', line_item_type: 'STANDARD' },
  pacing_status: { line_item_ids: [1], order_ids: [2] },
  fill_rate: { date_range: PAST, group_by: 'ad_unit' },
  inventory_breakdown: { date_range: PAST, group_by: 'order' },
  revenue_trend: { date_range: PAST, granularity: 'week', split_by: 'country' },
  compare_periods: {
    dimensions: ['AD_UNIT_ID'],
    metrics: ['IMPRESSIONS'],
    base_range: PAST,
    comparison: 'previous_period',
    top_n: 5,
  },
  find_anomalies: { kind: 'fill_rate_drops', threshold_pct: 10, top_n: 5 },
  kv_breakdown: { custom_targeting_key_id: 11, date_range: PAST, metric: 'revenue', top_n: 5, ad_unit_id: 1 },
  kv_report: { kv: 'section=news', date_range: PAST, metrics: ['IMPRESSIONS'], dimensions: ['DATE'] },
  bidder_breakdown: { date_range: PAST, group_by: 'day', top_n: 5 },
  yield_breakdown: { date_range: PAST, by: 'buyer', group_by: 'country', top_n: 5 },
  video_breakdown: { date_range: PAST, by: 'placement', group_by: 'device', top_n: 5 },
  viewability_breakdown: { date_range: PAST, by: 'size', group_by: 'day', top_n: 5 },
  reach_report: { date_range: PAST, by: 'order', group_by: 'country', ids: [2] },
  ad_speed: { date_range: PAST, by: 'device', focus: 'page_timing' },
  sell_through: { date_range: FUTURE, by: 'placement', ids: [3] },
  consent_messaging: { date_range: PAST, focus: 'att', group_by: 'os_group' },
  find_unused_ad_units: { lookback_days: 14, min_requests: 10, max_units: 100 },
  diagnose_fill_rate: { ad_unit_query: 'home', lookback_days: 7, comparison: 'none', top_n: 5, min_requests: 100 },
  diagnose_floor_pricing: { ad_unit_ids: [1], lookback_days: 7, min_requests: 100, top_n: 5 },
  health_check: {},
  usage_stats: {},
  save_query: {
    name: 'weekly_units',
    description: 'Impressions by ad unit.',
    dimensions: ['AD_UNIT_ID'],
    metrics: ['IMPRESSIONS'],
    replace: true,
  },
  list_saved_queries: {},
  run_saved_query: { name: 'weekly_units', date_range: { relative: 'last_7_days' } },
  delete_saved_query: { name: 'weekly_units' },
};

// What each tool must declare (spec §3.4, H2). Tools that read GAM are
// open-world; tools that never leave the process say so.
const GAM = { readOnlyHint: true, openWorldHint: true };
const LOCAL = { readOnlyHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export const ANNOTATIONS: Record<string, Record<string, boolean>> = {
  lookup: GAM,
  describe_schema: LOCAL,
  describe_line_item: GAM,
  run_report: GAM,
  fetch_report_page: GAM,
  revenue_summary: GAM,
  top_advertisers: GAM,
  top_line_items: GAM,
  pacing_status: GAM,
  fill_rate: GAM,
  inventory_breakdown: GAM,
  revenue_trend: GAM,
  compare_periods: GAM,
  find_anomalies: GAM,
  kv_breakdown: GAM,
  kv_report: GAM,
  bidder_breakdown: GAM,
  yield_breakdown: GAM,
  video_breakdown: GAM,
  viewability_breakdown: GAM,
  reach_report: GAM,
  ad_speed: GAM,
  sell_through: GAM,
  consent_messaging: GAM,
  find_unused_ad_units: GAM,
  diagnose_fill_rate: GAM,
  diagnose_floor_pricing: GAM,
  health_check: GAM,
  usage_stats: LOCAL,
  save_query: WRITES,
  list_saved_queries: LOCAL,
  run_saved_query: GAM,
  delete_saved_query: WRITES,
};

// Read from the source list, so a tool moved in or out of the saved-query
// set is reflected here without anyone remembering to edit this line.
export const SAVED_QUERY_TOOLS = SAVED_QUERY_TOOL_DEFS.map((t) => t.name);

// A copy of a tool's row; throws for a tool without one.
export function argsFor(tool: string): Record<string, unknown> {
  const args = VALID_ARGS[tool];
  if (!args) throw new Error(`tests/tool-table.ts has no valid arguments for ${tool}: add a row`);
  return structuredClone(args);
}

// Tools that never build a report definition.
export const NO_REPORT = new Set([
  'lookup', 'describe_schema', 'describe_line_item', 'fetch_report_page', 'health_check', 'usage_stats',
  'save_query', 'list_saved_queries', 'delete_saved_query',
]);

function memorySavedQueries(): SavedQueryStore {
  const entries = new Map<string, SavedQueryEntry>([[
    'weekly_units',
    { name: 'weekly_units', saved_at: '2026-09-01T00:00:00Z', body: { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] } },
  ]]);
  return {
    path: '(memory)',
    save: (name, body, description) => {
      const entry = { name, body, saved_at: '2026-09-17T04:00:00Z', ...(description && { description }) };
      entries.set(name, entry);
      return entry;
    },
    get: (name) => entries.get(name) ?? null,
    list: () => [...entries.values()],
    delete: (name) => entries.delete(name),
  };
}

// A context in which every row of VALID_ARGS succeeds: the entities and
// resources the rows name exist, a saved query is stored, and any report
// definition is answered with two rows whose cells are all empty.
export function toolWorld(over: Partial<ToolContext> = {}): ToolContext {
  const reports: ReportFixture[] = [];
  const ctx = makeCtx(
    {
      reports,
      entities: {
        ad_unit: [{ id: 1, name: 'Home top' }],
        company: [{ id: 5, name: 'Example advertiser' }],
        custom_targeting_key: [{ id: 11, name: 'section', displayName: 'Section' }],
      },
      resources: { 'lineItems/1': { name: `networks/${NETWORK}/lineItems/1`, displayName: 'Example line item' } },
    },
    { usageCounters: createUsageCounters(), savedQueries: memorySavedQueries(), ...over },
  );
  const inner = ctx.client;
  ctx.client = {
    ...inner,
    defineReport: (definition) => {
      const dateRange = definitionRange(definition) ?? undefined;
      // Two rows, distinguished on every requested dimension by index: a
      // join-sensitive tool (compare_periods) that groups by whatever
      // dimensions the request names must not see two identical rows and
      // read that as a duplicate join key (spec §4.1). Metrics stay blank —
      // nothing here depends on their values, only on there being two rows.
      const rowAt = (i: number) => Object.fromEntries(definition.dimensions.map((d) => [d, i]));
      reports.push({
        query: { dimensions: definition.dimensions, metrics: definition.metrics },
        dateRange,
        rows: [rowAt(0), rowAt(1)],
      });
      return inner.defineReport(definition);
    },
  };
  return ctx;
}
