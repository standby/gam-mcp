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
  ],
  metrics: [
    { name: 'TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS',           type: 'number',   description: 'Total served impressions at line-item level.' },
    { name: 'TOTAL_LINE_ITEM_LEVEL_CLICKS',                type: 'number',   description: 'Total clicks at line-item level.' },
    { name: 'TOTAL_LINE_ITEM_LEVEL_REVENUE',               type: 'currency', description: 'Total revenue (publisher currency, micros).' },
    { name: 'TOTAL_LINE_ITEM_LEVEL_CPM_AND_CPC_REVENUE',   type: 'currency', description: 'CPM+CPC revenue.' },
    { name: 'TOTAL_LINE_ITEM_LEVEL_CTR',                   type: 'rate',     description: 'Clicks ÷ impressions.' },
    { name: 'TOTAL_AD_REQUESTS',                           type: 'number',   description: 'Total ad requests received.' },
    { name: 'TOTAL_UNFILLED_IMPRESSIONS',                  type: 'number',   description: 'Requests without a fill.' },
    { name: 'TOTAL_LINE_ITEM_LEVEL_FILL_RATE',             type: 'rate',     description: 'Filled ÷ requests.' },
    { name: 'TOTAL_LINE_ITEM_LEVEL_VIEWABLE_IMPRESSIONS',  type: 'number',   description: 'Active-View viewable impressions.' },
    { name: 'TOTAL_LINE_ITEM_LEVEL_VIEWABILITY_RATE',      type: 'rate',     description: 'Viewable ÷ measurable impressions.' },
    { name: 'TOTAL_LINE_ITEM_LEVEL_VIDEO_COMPLETIONS',     type: 'number',   description: 'Video creative completions.' },
    { name: 'TOTAL_LINE_ITEM_LEVEL_VIDEO_COMPLETION_RATE', type: 'rate',     description: 'Completions ÷ video starts.' },
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
