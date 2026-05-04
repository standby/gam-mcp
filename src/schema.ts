export type DimensionDef = { name: string; type: 'string' | 'number' | 'date'; description: string };
export type MetricDef = { name: string; type: 'number' | 'currency' | 'rate'; description: string };

export const GAM_SCHEMA: { dimensions: DimensionDef[]; metrics: MetricDef[] } = {
  dimensions: [
    { name: 'DATE',                  type: 'date',   description: 'Calendar date in network timezone.' },
    { name: 'WEEK',                  type: 'date',   description: 'ISO week start (Monday).' },
    { name: 'MONTH_YEAR',            type: 'date',   description: 'Calendar month.' },
    { name: 'ADVERTISER_ID',         type: 'number', description: 'Advertiser (Company) ID.' },
    { name: 'ADVERTISER_NAME',       type: 'string', description: 'Advertiser display name.' },
    { name: 'ORDER_ID',              type: 'number', description: 'Order ID.' },
    { name: 'ORDER_NAME',            type: 'string', description: 'Order display name.' },
    { name: 'LINE_ITEM_ID',          type: 'number', description: 'Line item ID.' },
    { name: 'LINE_ITEM_NAME',        type: 'string', description: 'Line item display name.' },
    { name: 'LINE_ITEM_TYPE',        type: 'string', description: 'STANDARD, SPONSORSHIP, NETWORK, BULK, PRICE_PRIORITY, HOUSE, PROGRAMMATIC_GUARANTEED, PREFERRED_DEAL, AD_EXCHANGE, ADSENSE.' },
    { name: 'AD_UNIT_ID',            type: 'number', description: 'Ad unit ID (leaf).' },
    { name: 'AD_UNIT_NAME',          type: 'string', description: 'Ad unit display name.' },
    { name: 'CREATIVE_ID',           type: 'number', description: 'Creative ID.' },
    { name: 'CREATIVE_NAME',         type: 'string', description: 'Creative display name.' },
    { name: 'CREATIVE_TYPE',         type: 'string', description: 'IMAGE, VIDEO, HTML5, NATIVE, etc.' },
    { name: 'COUNTRY_NAME',          type: 'string', description: 'Country of impression.' },
    { name: 'DEVICE_CATEGORY_NAME',  type: 'string', description: 'DESKTOP, MOBILE, TABLET, etc.' },
    { name: 'LINE_ITEM_GOAL_QUANTITY',                    type: 'number', description: 'Line item booked goal quantity.' },
    { name: 'BUYER_NETWORK_NAME',    type: 'string', description: 'Demand-source name (DSP, AdSense, AdX, etc.). Best default for slicing programmatic revenue by buyer.' },
    { name: 'BUYER_NETWORK_ID',      type: 'number', description: 'Demand-source ID. Companion to BUYER_NETWORK_NAME.' },
    { name: 'BIDDER_NAME',           type: 'string', description: 'Open Bidding (EBDA) bidder display name. Use to attribute revenue to specific bidders participating in Open Bidding.' },
    { name: 'BIDDER_ENCRYPTED_ID',   type: 'string', description: 'Open Bidding bidder encrypted ID. Companion to BIDDER_NAME.' },
    { name: 'KEY_VALUES_NAME',       type: 'string', description: "Custom-targeting key=value pair from the ad request (e.g. '<key>=<value>'). WARNING: a single impression can match multiple KV pairs, so rows are NOT mutually exclusive — summing impressions/revenue across rows OVERSTATES the true total. Use for ranking 'which KVs are most active', not for share-of-total math. For clean aggregation, use CUSTOM_DIMENSION_<N>_VALUE with custom_dimension_key_ids." },
    { name: 'KEY_VALUES_ID',         type: 'number', description: 'Custom-targeting key=value ID. Companion to KEY_VALUES_NAME — same overlap caveat applies.' },
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
  ],
  metrics: [
    { name: 'IMPRESSIONS',                            type: 'number',   description: 'Total served impressions (all channels).' },
    { name: 'CLICKS',                                 type: 'number',   description: 'Total clicks (all channels).' },
    { name: 'REVENUE',                                type: 'currency', description: 'Total revenue (publisher currency).' },
    { name: 'CPM_REVENUE',                            type: 'currency', description: 'CPM revenue.' },
    { name: 'CPC_REVENUE',                            type: 'currency', description: 'CPC revenue.' },
    { name: 'CTR',                                    type: 'rate',     description: 'Clicks ÷ impressions.' },
    { name: 'AD_REQUESTS',                            type: 'number',   description: 'Total ad requests received.' },
    { name: 'UNFILLED_IMPRESSIONS',                   type: 'number',   description: 'Requests without a fill.' },
    { name: 'FILL_RATE',                              type: 'rate',     description: 'Filled ÷ requests.' },
    { name: 'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',       type: 'number',   description: 'Active View viewable impressions (all channels).' },
    { name: 'ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE',  type: 'rate',     description: 'Viewable ÷ measurable impressions.' },
    { name: 'VIDEO_VIEWERSHIP_COMPLETES',             type: 'number',   description: 'Video creative completions.' },
    { name: 'VIDEO_VIEWERSHIP_COMPLETION_RATE',       type: 'rate',     description: 'Completions ÷ video starts.' },
    { name: 'AD_SERVER_IMPRESSIONS',                  type: 'number',   description: 'Ad server impressions (excludes AdSense/Ad Exchange).' },
    { name: 'AD_SERVER_CLICKS',                       type: 'number',   description: 'Ad server clicks.' },
    { name: 'AD_SERVER_REVENUE',                      type: 'currency', description: 'Ad server revenue.' },
    { name: 'AD_SERVER_CTR',                          type: 'rate',     description: 'Ad server CTR.' },
    { name: 'AD_SERVER_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',      type: 'number', description: 'Ad server Active View viewable impressions.' },
    { name: 'AD_SERVER_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS_RATE', type: 'rate',   description: 'Ad server viewability rate.' },
    { name: 'AD_SERVER_AVERAGE_ECPM',                          type: 'currency', description: 'Average eCPM for ad-server impressions only (excludes AdX/AdSense backfill). Pair with AD_SERVER_IMPRESSIONS for clean direct-channel eCPM.' },
    { name: 'AD_SERVER_RESPONSES_SERVED',                      type: 'number',   description: 'Ad-server responses served — analogous to fills/matched requests, ad-server-only (excludes AdX/AdSense).' },
  ],
};

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
