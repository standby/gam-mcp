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
