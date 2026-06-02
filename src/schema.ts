// `incompatible_with` lists dimension or metric names that GAM refuses to
// combine with this entry in a single report. The matrix is curated from
// observed 400 responses ("Dimension X cannot be queried with metric Y") —
// it's not exhaustive, but surfaces the cases callers hit most often so
// describe_schema can flag them upfront instead of letting them discover at
// runtime. Symmetric on purpose: A → [B] AND B → [A] both appear, so a
// caller looking up either side sees the constraint.
export type DimensionDef = {
  name: string;
  type: 'string' | 'number' | 'date';
  description: string;
  incompatible_with?: string[];
};
export type MetricDef = {
  name: string;
  type: 'number' | 'currency' | 'rate';
  description: string;
  incompatible_with?: string[];
};

export const GAM_SCHEMA: { dimensions: DimensionDef[]; metrics: MetricDef[] } = {
  dimensions: [
    { name: 'DATE',                  type: 'date',   description: 'Calendar date in network timezone.' },
    { name: 'WEEK',                  type: 'date',   description: 'ISO week start (Monday).' },
    { name: 'MONTH_YEAR',            type: 'date',   description: 'Calendar month.' },
    { name: 'HOUR',                  type: 'number', description: 'Hour of day (0–23) in network timezone. Pair with DATE for time-of-day / dayparting analysis.' },
    { name: 'DAY_OF_WEEK',           type: 'number', description: 'Day of week as an integer (GAM convention: 1=Sunday … 7=Saturday). Use for weekday-vs-weekend performance patterns.' },
    { name: 'ADVERTISER_ID',         type: 'number', description: 'Advertiser (Company) ID.' },
    { name: 'ADVERTISER_NAME',       type: 'string', description: 'Advertiser display name.' },
    { name: 'ORDER_ID',              type: 'number', description: 'Order ID.' },
    { name: 'ORDER_NAME',            type: 'string', description: 'Order display name.' },
    { name: 'LINE_ITEM_ID',          type: 'number', description: 'Line item ID.' },
    { name: 'LINE_ITEM_NAME',        type: 'string', description: 'Line item display name.' },
    { name: 'LINE_ITEM_TYPE',        type: 'string', description: 'STANDARD, SPONSORSHIP, NETWORK, BULK, PRICE_PRIORITY, HOUSE, PROGRAMMATIC_GUARANTEED, PREFERRED_DEAL, AD_EXCHANGE, ADSENSE.' },
    { name: 'AD_UNIT_ID',            type: 'number', description: 'Ad unit ID (leaf).' },
    { name: 'AD_UNIT_NAME',          type: 'string', description: 'Ad unit display name. Note: GAM REST exposes only the leaf ad unit — there is no top-level / ancestor ad-unit dimension.' },
    { name: 'PLACEMENT_ID',          type: 'number', description: 'Placement ID. Placements group ad units for targeting/reporting.' },
    { name: 'PLACEMENT_NAME',        type: 'string', description: 'Placement display name. Use to roll up performance across the ad units a placement groups.' },
    { name: 'INVENTORY_FORMAT_NAME', type: 'string', description: 'Inventory format the impression served in (e.g. display, video, native).' },
    { name: 'CREATIVE_ID',           type: 'number', description: 'Creative ID.' },
    { name: 'CREATIVE_NAME',         type: 'string', description: 'Creative display name.' },
    { name: 'CREATIVE_TYPE',         type: 'string', description: 'IMAGE, VIDEO, HTML5, NATIVE, etc.' },
    { name: 'RENDERED_CREATIVE_SIZE', type: 'string', description: "Creative size, as 'WIDTHxHEIGHT' (e.g. '300x250'). Maps to 'Rendered creative size' in the GAM UI — the size the creative actually rendered at, which can differ from its native size when it serves into a differently-sized slot. GAM's REST API has no plain 'CREATIVE_SIZE'; 'CREATIVE_SIZE' is accepted as an alias and rewritten to this. Creative-level, so only defined for filled impressions — not valid with request-level metrics (AD_REQUESTS, UNFILLED_IMPRESSIONS)." },
    { name: 'VIDEO_PLCMT_NAME',      type: 'string', description: 'Video placement type (e.g. in-stream, in-banner, in-article, in-feed, interstitial). Use to compare instream vs outstream video performance.' },
    { name: 'VIDEO_AD_DURATION',     type: 'string', description: 'Duration bucket of the served video ad (string label). Use to break down video delivery/yield by ad length.' },
    { name: 'COUNTRY_NAME',          type: 'string', description: 'Country of impression.' },
    { name: 'REGION_NAME',           type: 'string', description: 'Region / state of impression (sub-country). Pair with COUNTRY_NAME to disambiguate same-named regions.' },
    { name: 'METRO_NAME',            type: 'string', description: 'Metro / DMA of impression (primarily US designated market areas).' },
    { name: 'DEVICE_CATEGORY_NAME',  type: 'string', description: 'DESKTOP, MOBILE, TABLET, etc.' },
    { name: 'DEMAND_CHANNEL_NAME',   type: 'string', description: 'Demand channel that served the impression (e.g. direct/reservation vs programmatic vs AdSense). Best single dimension for splitting revenue by channel at a glance.' },
    { name: 'LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE',      type: 'number', description: 'Line item booked goal in absolute units (impressions/clicks). For SPONSORSHIP line items the goal is a percentage instead — see LINE_ITEM_PRIMARY_GOAL_UNITS_PERCENTAGE.' },
    { name: 'LINE_ITEM_PRIMARY_GOAL_UNITS_PERCENTAGE',    type: 'number', description: 'Line item booked goal as a percentage of inventory (used by SPONSORSHIP).' },
    { name: 'LINE_ITEM_PRIMARY_GOAL_TYPE_NAME',           type: 'string', description: 'Goal type label (LIFETIME / DAILY / NONE).' },
    { name: 'BUYER_NETWORK_NAME',    type: 'string', description: 'Demand-source name (DSP, AdSense, AdX, etc.). Best default for slicing programmatic revenue by buyer.',
      incompatible_with: ['AD_REQUESTS', 'UNFILLED_IMPRESSIONS', 'AD_SERVER_IMPRESSIONS', 'AD_SERVER_REVENUE', 'AD_SERVER_RESPONSES_SERVED'] },
    { name: 'BUYER_NETWORK_ID',      type: 'number', description: 'Demand-source ID. Companion to BUYER_NETWORK_NAME.',
      incompatible_with: ['AD_REQUESTS', 'UNFILLED_IMPRESSIONS', 'AD_SERVER_IMPRESSIONS', 'AD_SERVER_REVENUE', 'AD_SERVER_RESPONSES_SERVED'] },
    { name: 'BIDDER_NAME',           type: 'string', description: 'Open Bidding (EBDA) bidder display name. Use to attribute revenue to specific bidders participating in Open Bidding.',
      incompatible_with: ['AD_REQUESTS', 'UNFILLED_IMPRESSIONS', 'AD_SERVER_IMPRESSIONS', 'AD_SERVER_REVENUE', 'ADSENSE_IMPRESSIONS', 'ADSENSE_REVENUE'] },
    { name: 'BIDDER_ENCRYPTED_ID',   type: 'string', description: 'Open Bidding bidder encrypted ID. Companion to BIDDER_NAME.',
      incompatible_with: ['AD_REQUESTS', 'UNFILLED_IMPRESSIONS', 'AD_SERVER_IMPRESSIONS', 'AD_SERVER_REVENUE', 'ADSENSE_IMPRESSIONS', 'ADSENSE_REVENUE'] },
    { name: 'KEY_VALUES_NAME',       type: 'string', description: "Custom-targeting key=value pair from the ad request (e.g. '<key>=<value>'). WARNING: a single impression can match multiple KV pairs, so rows are NOT mutually exclusive — summing impressions/revenue across rows OVERSTATES the true total. Use for ranking 'which KVs are most active', not for share-of-total math. For clean aggregation, use CUSTOM_DIMENSION_<N>_VALUE with custom_dimension_key_ids.",
      incompatible_with: ['AD_REQUESTS', 'UNFILLED_IMPRESSIONS', 'AD_EXCHANGE_IMPRESSIONS', 'AD_EXCHANGE_REVENUE', 'AD_EXCHANGE_AVERAGE_ECPM', 'AD_EXCHANGE_MATCH_RATE', 'AD_EXCHANGE_TOTAL_REQUESTS', 'AD_EXCHANGE_CTR', 'ADSENSE_IMPRESSIONS', 'ADSENSE_REVENUE', 'ADSENSE_AVERAGE_ECPM'] },
    { name: 'KEY_VALUES_ID',         type: 'number', description: 'Custom-targeting key=value ID. Companion to KEY_VALUES_NAME — same overlap caveat applies.',
      incompatible_with: ['AD_REQUESTS', 'UNFILLED_IMPRESSIONS', 'AD_EXCHANGE_IMPRESSIONS', 'AD_EXCHANGE_REVENUE', 'AD_EXCHANGE_AVERAGE_ECPM', 'AD_EXCHANGE_MATCH_RATE', 'AD_EXCHANGE_TOTAL_REQUESTS', 'AD_EXCHANGE_CTR', 'ADSENSE_IMPRESSIONS', 'ADSENSE_REVENUE', 'ADSENSE_AVERAGE_ECPM'] },
    { name: 'CUSTOM_DIMENSION_0_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 0. REQUIRES passing custom_dimension_key_ids[0]=<key_id> on run_report — find key IDs via lookup(entity_type="custom_targeting_key"). Each request emits exactly one value per slot, so rows aggregate cleanly to network total. Slot meaning is per-network — different publishers configure different keys.' },
    { name: 'CUSTOM_DIMENSION_1_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 1. REQUIRES custom_dimension_key_ids[1]. Aggregates cleanly (one value per request).' },
    { name: 'CUSTOM_DIMENSION_2_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 2. REQUIRES custom_dimension_key_ids[2]. Aggregates cleanly.' },
    { name: 'CUSTOM_DIMENSION_3_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 3. REQUIRES custom_dimension_key_ids[3]. Aggregates cleanly.' },
    { name: 'CUSTOM_DIMENSION_4_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 4. REQUIRES custom_dimension_key_ids[4]. Aggregates cleanly.' },
    { name: 'CUSTOM_DIMENSION_5_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 5. REQUIRES custom_dimension_key_ids[5]. Aggregates cleanly.' },
    { name: 'CUSTOM_DIMENSION_6_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 6. REQUIRES custom_dimension_key_ids[6]. Aggregates cleanly.' },
    { name: 'CUSTOM_DIMENSION_7_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 7. REQUIRES custom_dimension_key_ids[7]. Aggregates cleanly.' },
    { name: 'CUSTOM_DIMENSION_8_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 8. REQUIRES custom_dimension_key_ids[8]. Aggregates cleanly.' },
    { name: 'CUSTOM_DIMENSION_9_VALUE', type: 'string', description: 'Publisher-configured custom dimension at slot 9. REQUIRES custom_dimension_key_ids[9]. Aggregates cleanly.' },
    { name: 'TAXONOMY_CATEGORY',    type: 'string', description: "Taxonomy category of the served content (GAM REST 'TAXONOMY_CATEGORY'). On networks with Publisher Provided Signals (PPS) configured, this typically surfaces the IAB Content Taxonomy category the request was tagged with; on other networks it may reflect GAM's older content-classification feature. Probe values on a small report to confirm semantics for your network. PPS-specific dimensions (top level / all levels / data provider / delivered) are UI-only in the GAM query tool (Beta) and not yet exposed in the REST Dimension enum." },
    { name: 'TAXONOMY_CATEGORY_ID', type: 'number', description: 'Numeric ID companion to TAXONOMY_CATEGORY. For IAB-Taxonomy-tagged inventory this maps to the IAB taxonomy node ID; otherwise to a GAM-internal category ID.' },
  ],
  metrics: [
    { name: 'IMPRESSIONS',                            type: 'number',   description: 'Total served impressions (all channels).' },
    { name: 'CLICKS',                                 type: 'number',   description: 'Total clicks (all channels).' },
    { name: 'REVENUE',                                type: 'currency', description: 'Total revenue (publisher currency).' },
    { name: 'CPM_REVENUE',                            type: 'currency', description: 'CPM revenue.' },
    { name: 'AVERAGE_ECPM',                           type: 'currency', description: "Total average eCPM — revenue per thousand impressions averaged across ad server, AdSense, and Ad Exchange. Best default for a blended 'eCPM' number. For channel-specific eCPM use AD_SERVER_AVERAGE_ECPM, AD_EXCHANGE_AVERAGE_ECPM, or ADSENSE_AVERAGE_ECPM." },
    { name: 'CPC_REVENUE',                            type: 'currency', description: 'CPC revenue.' },
    { name: 'CTR',                                    type: 'rate',     description: 'Clicks ÷ impressions.' },
    { name: 'AD_REQUESTS',                            type: 'number',   description: 'Total ad requests received.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'BUYER_NETWORK_NAME', 'BUYER_NETWORK_ID', 'BIDDER_NAME', 'BIDDER_ENCRYPTED_ID', 'CREATIVE_ID', 'CREATIVE_NAME', 'CREATIVE_TYPE', 'RENDERED_CREATIVE_SIZE', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE'] },
    { name: 'UNFILLED_IMPRESSIONS',                   type: 'number',   description: 'Requests without a fill.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'BUYER_NETWORK_NAME', 'BUYER_NETWORK_ID', 'BIDDER_NAME', 'BIDDER_ENCRYPTED_ID', 'CREATIVE_ID', 'CREATIVE_NAME', 'RENDERED_CREATIVE_SIZE', 'LINE_ITEM_ID', 'LINE_ITEM_NAME'] },
    { name: 'FILL_RATE',                              type: 'rate',     description: 'Filled ÷ requests.' },
    { name: 'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',       type: 'number',   description: 'Active View viewable impressions (all channels).' },
    { name: 'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',  type: 'rate',     description: 'Viewable ÷ measurable impressions.' },
    { name: 'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',     type: 'number',   description: 'Impressions that were measurable by Active View — the denominator of the viewable rate. Pair with ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS to see measurement coverage.' },
    { name: 'ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',       type: 'number',   description: 'Impressions eligible for Active View measurement (the universe before measurability). Use measurable ÷ eligible to gauge how much inventory could be measured.' },
    { name: 'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE', type: 'rate',    description: 'Measurable ÷ eligible impressions — share of inventory that Active View could actually measure.' },
    { name: 'VIDEO_VIEWERSHIP_STARTS',                type: 'number',   description: 'Video ad starts (impressions that began playing). Top of the video completion funnel.' },
    { name: 'VIDEO_VIEWERSHIP_FIRST_QUARTILES',       type: 'number',   description: 'Video plays reaching 25% (first quartile).' },
    { name: 'VIDEO_VIEWERSHIP_MIDPOINTS',             type: 'number',   description: 'Video plays reaching 50% (midpoint).' },
    { name: 'VIDEO_VIEWERSHIP_THIRD_QUARTILES',       type: 'number',   description: 'Video plays reaching 75% (third quartile).' },
    { name: 'VIDEO_VIEWERSHIP_COMPLETES',             type: 'number',   description: 'Video creative completions (100%).' },
    { name: 'VIDEO_VIEWERSHIP_COMPLETION_RATE',       type: 'rate',     description: 'Completions ÷ video starts.' },
    { name: 'VIDEO_VIEWERSHIP_VIEW_THROUGH_RATE',     type: 'rate',     description: 'View-through rate — completes ÷ starts expressed as a percent (VTR).' },
    { name: 'VIDEO_VIEWERSHIP_AVERAGE_VIEW_TIME',     type: 'number',   description: 'Average time (seconds) a video ad was viewed.' },
    { name: 'VIDEO_VIEWERSHIP_AVERAGE_VIEW_RATE',     type: 'rate',     description: 'Average percentage of the video ad that was viewed.' },
    { name: 'AD_SERVER_IMPRESSIONS',                  type: 'number',   description: 'Ad server impressions (excludes AdSense/Ad Exchange).' },
    { name: 'AD_SERVER_CLICKS',                       type: 'number',   description: 'Ad server clicks.' },
    { name: 'AD_SERVER_REVENUE',                      type: 'currency', description: 'Ad server revenue.' },
    { name: 'AD_SERVER_CTR',                          type: 'rate',     description: 'Ad server CTR.' },
    { name: 'AD_SERVER_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',      type: 'number', description: 'Ad server Active View viewable impressions.' },
    { name: 'AD_SERVER_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE', type: 'rate',   description: 'Ad server viewability rate.' },
    { name: 'AD_SERVER_AVERAGE_ECPM',                          type: 'currency', description: 'Average eCPM for ad-server impressions only (excludes AdX/AdSense backfill). Pair with AD_SERVER_IMPRESSIONS for clean direct-channel eCPM.' },
    { name: 'AD_SERVER_RESPONSES_SERVED',                      type: 'number',   description: 'Ad-server responses served — analogous to fills/matched requests, ad-server-only (excludes AdX/AdSense).' },
    { name: 'AD_EXCHANGE_IMPRESSIONS',                         type: 'number',   description: 'Ad Exchange (AdX / Open Bidding) impressions — programmatic-only fills, excludes direct/AdSense.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE'] },
    { name: 'AD_EXCHANGE_REVENUE',                             type: 'currency', description: 'Ad Exchange revenue — programmatic-only.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE'] },
    { name: 'AD_EXCHANGE_AVERAGE_ECPM',                        type: 'currency', description: 'Average eCPM on Ad Exchange impressions. Use with BUYER_NETWORK_NAME or BIDDER_NAME to compare DSP yield.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE'] },
    { name: 'AD_EXCHANGE_MATCH_RATE',                          type: 'rate',     description: 'AdX match rate: matched requests ÷ total AdX requests. Below ~50% suggests floor pricing too high or weak demand.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'CREATIVE_ID', 'CREATIVE_NAME', 'ADVERTISER_ID', 'ADVERTISER_NAME', 'ORDER_ID', 'ORDER_NAME'] },
    { name: 'AD_EXCHANGE_TOTAL_REQUESTS',                      type: 'number',   description: 'Total AdX requests (matched + unmatched). Pair with AD_EXCHANGE_MATCH_RATE for funnel analysis.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'CREATIVE_ID', 'CREATIVE_NAME', 'ADVERTISER_ID', 'ADVERTISER_NAME', 'ORDER_ID', 'ORDER_NAME'] },
    { name: 'AD_EXCHANGE_CTR',                                 type: 'rate',     description: 'AdX click-through rate.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE'] },
    { name: 'ADSENSE_IMPRESSIONS',                             type: 'number',   description: 'AdSense backfill impressions (after AdX, before unfilled).',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'BIDDER_NAME', 'BIDDER_ENCRYPTED_ID', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE'] },
    { name: 'ADSENSE_REVENUE',                                 type: 'currency', description: 'AdSense backfill revenue.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'BIDDER_NAME', 'BIDDER_ENCRYPTED_ID', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE'] },
    { name: 'ADSENSE_AVERAGE_ECPM',                            type: 'currency', description: 'Average eCPM on AdSense backfill — typically the floor of programmatic eCPM tiers.',
      incompatible_with: ['KEY_VALUES_NAME', 'KEY_VALUES_ID', 'BIDDER_NAME', 'BIDDER_ENCRYPTED_ID', 'LINE_ITEM_ID', 'LINE_ITEM_NAME', 'LINE_ITEM_TYPE'] },
  ],
};

// Friendly / legacy dimension names that map onto a canonical REST dimension.
// GAM's REST v1 API has no `CREATIVE_SIZE` — the equivalent is
// RENDERED_CREATIVE_SIZE. We accept the familiar name and rewrite it so a
// caller asking for "CREATIVE_SIZE" gets data instead of a 400 from GAM.
export const DIMENSION_ALIASES: Record<string, string> = {
  CREATIVE_SIZE: 'RENDERED_CREATIVE_SIZE',
};

// Map a dimension name to its canonical REST name, or return it unchanged.
export function resolveDimensionAlias(name: string): string {
  return DIMENSION_ALIASES[name] ?? name;
}

const DIMS = new Set(GAM_SCHEMA.dimensions.map((d) => d.name));
const METRICS = new Set(GAM_SCHEMA.metrics.map((m) => m.name));

export function isValidDimension(name: string): boolean {
  return DIMS.has(name);
}
export function isValidMetric(name: string): boolean {
  return METRICS.has(name);
}

export function validateCombo(q: { dimensions: string[]; metrics: string[] }): string | null {
  for (const d of q.dimensions) {
    if (!isValidDimension(d)) return `Unknown dimension: ${d}`;
  }
  for (const m of q.metrics) {
    if (!isValidMetric(m)) return `Unknown metric: ${m}`;
  }
  return null;
}

const DIM_BY_NAME = new Map(GAM_SCHEMA.dimensions.map((d) => [d.name, d]));
const METRIC_BY_NAME = new Map(GAM_SCHEMA.metrics.map((m) => [m.name, m]));

// Returns the curated incompatibilities for a dimension or metric name, or []
// if none are recorded. Symmetric: callers can pass either side.
export function incompatibleWith(name: string): string[] {
  return DIM_BY_NAME.get(name)?.incompatible_with
    ?? METRIC_BY_NAME.get(name)?.incompatible_with
    ?? [];
}

// Pre-flight a query against the curated incompatibility matrix. Returns a
// list of conflicts {a, b} (only one direction per pair), or [] if clean.
// The matrix is best-effort — GAM is still the source of truth, so callers
// should treat this as a hint, not a hard validator. Empty result does not
// guarantee GAM will accept the combo.
export function findIncompatibilities(q: {
  dimensions: string[];
  metrics: string[];
}): Array<{ a: string; b: string }> {
  const all = [...q.dimensions, ...q.metrics];
  const seen = new Set<string>();
  const conflicts: Array<{ a: string; b: string }> = [];
  for (const a of all) {
    const bad = new Set(incompatibleWith(a));
    for (const b of all) {
      if (a === b) continue;
      if (!bad.has(b)) continue;
      const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({ a, b });
    }
  }
  return conflicts;
}
