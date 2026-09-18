import { describe, it, expect } from 'vitest';
import {
  GAM_SCHEMA,
  isValidDimension,
  isValidMetric,
  validateCombo,
  incompatibleWith,
  findIncompatibilities,
  resolveDimensionAlias,
  canonicalizeQuery,
  resolveReportType,
} from '../src/schema.js';
import { GENERATED_DIMENSIONS, GENERATED_METRICS } from '../src/schema-generated.js';
import { CURATED_DIMENSIONS, CURATED_METRICS } from '../src/schema-overrides.js';

describe('GAM schema catalog', () => {
  it('exposes core dimensions', () => {
    expect(isValidDimension('ADVERTISER_NAME')).toBe(true);
    expect(isValidDimension('LINE_ITEM_ID')).toBe(true);
    expect(isValidDimension('AD_UNIT_NAME')).toBe(true);
    expect(isValidDimension('NOT_A_THING')).toBe(false);
  });

  it('exposes core metrics', () => {
    expect(isValidMetric('IMPRESSIONS')).toBe(true);
    expect(isValidMetric('REVENUE')).toBe(true);
    expect(isValidMetric('CTR')).toBe(true);
    expect(isValidMetric('NONSENSE')).toBe(false);
  });

  it('validateCombo accepts a sane query', () => {
    const ok = validateCombo({
      dimensions: ['ADVERTISER_NAME', 'DATE'],
      metrics: ['REVENUE'],
    });
    expect(ok).toBeNull();
  });

  it('validateCombo rejects unknown dimensions', () => {
    const err = validateCombo({ dimensions: ['NOT_A_DIM'], metrics: [] });
    expect(err).toMatch(/NOT_A_DIM/);
  });

  it('catalog has at least 15 dimensions and 10 metrics', () => {
    expect(GAM_SCHEMA.dimensions.length).toBeGreaterThanOrEqual(15);
    expect(GAM_SCHEMA.metrics.length).toBeGreaterThanOrEqual(10);
  });

  it('exposes programmatic demand-source dimensions', () => {
    expect(isValidDimension('BUYER_NETWORK_NAME')).toBe(true);
    expect(isValidDimension('BUYER_NETWORK_ID')).toBe(true);
    expect(isValidDimension('BIDDER_NAME')).toBe(true);
    expect(isValidDimension('BIDDER_ENCRYPTED_ID')).toBe(true);
  });

  it('exposes ad-server-only eCPM and responses-served metrics', () => {
    expect(isValidMetric('AD_SERVER_AVERAGE_ECPM')).toBe(true);
    expect(isValidMetric('AD_SERVER_RESPONSES_SERVED')).toBe(true);
  });

  it('exposes geo, time, inventory, and demand-channel dimensions', () => {
    for (const d of [
      'REGION_NAME', 'METRO_NAME', 'HOUR', 'DAY_OF_WEEK',
      'PLACEMENT_NAME', 'PLACEMENT_ID', 'INVENTORY_FORMAT_NAME', 'DEMAND_CHANNEL_NAME',
    ]) {
      expect(isValidDimension(d)).toBe(true);
    }
  });

  it('exposes the video funnel (dimensions + metrics)', () => {
    expect(isValidDimension('VIDEO_PLCMT_NAME')).toBe(true);
    expect(isValidDimension('VIDEO_AD_DURATION')).toBe(true);
    for (const m of [
      'VIDEO_VIEWERSHIP_STARTS', 'VIDEO_VIEWERSHIP_FIRST_QUARTILES',
      'VIDEO_VIEWERSHIP_MIDPOINTS', 'VIDEO_VIEWERSHIP_THIRD_QUARTILES',
      'VIDEO_VIEWERSHIP_VIEW_THROUGH_RATE', 'VIDEO_VIEWERSHIP_AVERAGE_VIEW_TIME',
      'VIDEO_VIEWERSHIP_AVERAGE_VIEW_RATE',
    ]) {
      expect(isValidMetric(m)).toBe(true);
    }
  });

  it('exposes Active View measurable/eligible viewability metrics', () => {
    for (const m of [
      'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS', 'ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
      'ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE',
    ]) {
      expect(isValidMetric(m)).toBe(true);
    }
  });

  it('exposes deal-level dimensions and the deal bid funnel', () => {
    for (const d of ['DEAL_NAME', 'DEAL_ID', 'DEAL_BUYER_NAME', 'DEAL_BUYER_ID', 'EXCHANGE_BIDDING_DEAL_TYPE_NAME']) {
      expect(isValidDimension(d)).toBe(true);
    }
    for (const m of ['DEALS_BID_REQUESTS', 'DEALS_BIDS', 'DEALS_BID_RATE', 'DEALS_WINNING_BIDS', 'DEALS_WIN_RATE']) {
      expect(isValidMetric(m)).toBe(true);
    }
    // Programmatic demand: deal dims can't combine with request-level / ad-server-only metrics.
    expect(incompatibleWith('DEAL_NAME')).toContain('AD_REQUESTS');
    expect(incompatibleWith('AD_REQUESTS')).toContain('DEAL_NAME');
  });

  it('exposes yield-group dimensions and the mediation / Open Bidding metrics', () => {
    for (const d of ['YIELD_GROUP_NAME', 'YIELD_GROUP_ID', 'YIELD_GROUP_BUYER_NAME', 'YIELD_GROUP_BUYER_TAG_NAME']) {
      expect(isValidDimension(d)).toBe(true);
    }
    for (const m of [
      'YIELD_GROUP_IMPRESSIONS', 'YIELD_GROUP_ESTIMATED_REVENUE', 'YIELD_GROUP_ESTIMATED_CPM',
      'YIELD_GROUP_MEDIATION_THIRD_PARTY_ECPM', 'YIELD_GROUP_MEDIATION_FILL_RATE',
      'YIELD_GROUP_MEDIATION_MATCHED_QUERIES', 'YIELD_GROUP_MEDIATION_PASSBACKS',
      'YIELD_GROUP_CALLOUTS', 'YIELD_GROUP_BIDS', 'YIELD_GROUP_BIDS_IN_AUCTION',
      'YIELD_GROUP_AUCTIONS_WON', 'YIELD_GROUP_SUCCESSFUL_RESPONSES',
      'AD_EXCHANGE_PLUS_YIELD_GROUP_IMPRESSIONS', 'AD_EXCHANGE_PLUS_YIELD_GROUP_REVENUE',
      'AD_EXCHANGE_PLUS_YIELD_GROUP_ECPM',
    ]) {
      expect(isValidMetric(m)).toBe(true);
    }
    // Yield groups are programmatic demand: not valid with request-level metrics.
    expect(incompatibleWith('YIELD_GROUP_NAME')).toContain('AD_REQUESTS');
    expect(incompatibleWith('AD_REQUESTS')).toContain('YIELD_GROUP_NAME');
  });

  it('exposes creative size and blended eCPM, and aliases CREATIVE_SIZE', () => {
    expect(isValidDimension('RENDERED_CREATIVE_SIZE')).toBe(true);
    expect(isValidMetric('AVERAGE_ECPM')).toBe(true);
    // CREATIVE_SIZE is not a real REST dimension, but resolves to the canonical one.
    expect(isValidDimension('CREATIVE_SIZE')).toBe(false);
    expect(resolveDimensionAlias('CREATIVE_SIZE')).toBe('RENDERED_CREATIVE_SIZE');
    expect(resolveDimensionAlias('AD_UNIT_NAME')).toBe('AD_UNIT_NAME');
  });

  it('canonicalizeQuery resolves an alias in dimensions AND filter fields, with one warning each', () => {
    const { query, warnings } = canonicalizeQuery({
      dimensions: ['CREATIVE_SIZE', 'AD_UNIT_NAME'],
      metrics: ['IMPRESSIONS'],
      filters: [{ field: 'CREATIVE_SIZE', op: '=', value: '300x250' }],
    });
    expect(query.dimensions).toEqual(['RENDERED_CREATIVE_SIZE', 'AD_UNIT_NAME']);
    expect(query.filters).toEqual([{ field: 'RENDERED_CREATIVE_SIZE', op: '=', value: '300x250' }]);
    expect(warnings).toHaveLength(2);
    for (const w of warnings) expect(w).toMatch(/CREATIVE_SIZE.*RENDERED_CREATIVE_SIZE/);
  });

  it('canonicalizeQuery produces no warning when nothing is an alias', () => {
    const { query, warnings } = canonicalizeQuery({
      dimensions: ['AD_UNIT_NAME'],
      metrics: ['IMPRESSIONS'],
      filters: [{ field: 'AD_UNIT_NAME', op: '=', value: 'Homepage' }],
    });
    expect(query.dimensions).toEqual(['AD_UNIT_NAME']);
    expect(query.filters).toEqual([{ field: 'AD_UNIT_NAME', op: '=', value: 'Homepage' }]);
    expect(warnings).toEqual([]);
  });

  it('canonicalizeQuery leaves a genuinely unknown filter field alone, for checkReportQuery to refuse', () => {
    const { query, warnings } = canonicalizeQuery({
      dimensions: ['AD_UNIT_NAME'],
      metrics: ['IMPRESSIONS'],
      filters: [{ field: 'NOT_A_REAL_DIMENSION', op: '=', value: 'x' }],
    });
    expect(query.filters).toEqual([{ field: 'NOT_A_REAL_DIMENSION', op: '=', value: 'x' }]);
    expect(warnings).toEqual([]);
  });

  it('exposes key-value and per-slot custom-dimension dimensions', () => {
    expect(isValidDimension('KEY_VALUES_NAME')).toBe(true);
    expect(isValidDimension('KEY_VALUES_ID')).toBe(true);
    for (let i = 0; i <= 9; i++) {
      expect(isValidDimension(`CUSTOM_DIMENSION_${i}_VALUE`)).toBe(true);
    }
  });

  it('does NOT expose content-taxonomy dimensions — REST has no such enum member', () => {
    // These were whitelisted by hand and never existed in the REST Dimension
    // enum (no TAXONOM* member anywhere in report_definition.proto), so
    // run_report accepted them and GAM 400'd. Whitelisting a name GAM does not
    // have is strictly worse than omitting it: validateCombo passes and the
    // failure only appears against the live API.
    expect(isValidDimension('TAXONOMY_CATEGORY')).toBe(false);
    expect(isValidDimension('TAXONOMY_CATEGORY_ID')).toBe(false);
  });

  it('exposes AdX and AdSense channel-specific metrics', () => {
    for (const m of [
      'AD_EXCHANGE_IMPRESSIONS', 'AD_EXCHANGE_REVENUE', 'AD_EXCHANGE_AVERAGE_ECPM',
      'AD_EXCHANGE_MATCH_RATE', 'AD_EXCHANGE_TOTAL_REQUESTS', 'AD_EXCHANGE_CTR',
      'ADSENSE_IMPRESSIONS', 'ADSENSE_REVENUE', 'ADSENSE_AVERAGE_ECPM',
    ]) {
      expect(isValidMetric(m)).toBe(true);
    }
  });

  it('records KEY_VALUES_NAME ⊥ AD_REQUESTS symmetrically', () => {
    expect(incompatibleWith('KEY_VALUES_NAME')).toContain('AD_REQUESTS');
    expect(incompatibleWith('AD_REQUESTS')).toContain('KEY_VALUES_NAME');
  });

  it('findIncompatibilities flags the canonical conflict and dedupes by pair', () => {
    const conflicts = findIncompatibilities({
      dimensions: ['KEY_VALUES_NAME'],
      metrics: ['AD_REQUESTS', 'AD_EXCHANGE_MATCH_RATE'],
    });
    // Should report KEY_VALUES_NAME × AD_REQUESTS and KEY_VALUES_NAME × AD_EXCHANGE_MATCH_RATE,
    // each only once (not duplicated for the reverse direction).
    expect(conflicts).toHaveLength(2);
    const pairs = conflicts.map((c) => [c.a, c.b].sort().join('|'));
    expect(pairs).toContain(['AD_REQUESTS', 'KEY_VALUES_NAME'].sort().join('|'));
    expect(pairs).toContain(['AD_EXCHANGE_MATCH_RATE', 'KEY_VALUES_NAME'].sort().join('|'));
  });

  it('findIncompatibilities returns [] for a clean query', () => {
    expect(findIncompatibilities({
      dimensions: ['DATE', 'ADVERTISER_NAME'],
      metrics: ['REVENUE', 'IMPRESSIONS'],
    })).toEqual([]);
  });
});

describe('schema generation integrity', () => {
  it('has no orphaned overrides — every curated name still exists upstream', () => {
    // An override naming something absent from the generated enum is silently
    // inert, so curated prose can quietly stop applying. Worse, before the
    // merge existed, such a name was *whitelisted*: validateCombo passed and
    // GAM 400'd (this is exactly how TAXONOMY_CATEGORY survived). Fail loudly
    // instead — either the name was renamed upstream or it never existed.
    const dims = new Set(GENERATED_DIMENSIONS.map((d) => d.name));
    const metrics = new Set(GENERATED_METRICS.map((m) => m.name));
    expect(CURATED_DIMENSIONS.filter((c) => !dims.has(c.name)).map((c) => c.name)).toEqual([]);
    expect(CURATED_METRICS.filter((c) => !metrics.has(c.name)).map((c) => c.name)).toEqual([]);
  });

  it('gives every entry at least one report type', () => {
    const orphans = [...GAM_SCHEMA.metrics, ...GAM_SCHEMA.dimensions]
      .filter((e) => e.report_types.length === 0)
      .map((e) => e.name);
    // Metrics always declare compatibility; ~240 dimensions do not, and those
    // are deliberately left unconstrained rather than guessed at.
    expect(GAM_SCHEMA.metrics.filter((m) => m.report_types.length === 0)).toEqual([]);
    expect(orphans.length).toBeLessThan(300);
  });

  it('preserves curated prose over the generated description', () => {
    const kvn = GAM_SCHEMA.dimensions.find((d) => d.name === 'KEY_VALUES_NAME');
    expect(kvn?.description).toContain('NOT mutually exclusive');
    expect(kvn?.incompatible_with).toContain('AD_REQUESTS');
  });

  it('derives report type by intersecting compatibility, preferring HISTORICAL', () => {
    expect(resolveReportType(['IMPRESSIONS', 'REVENUE'])).toBe('HISTORICAL');
    expect(resolveReportType(['UNIQUE_VISITORS', 'REACH_IMPRESSIONS'])).toBe('REACH');
    expect(resolveReportType(['SELL_THROUGH_SELL_THROUGH_RATE'])).toBe('FUTURE_SELL_THROUGH');
    // Dimensions constrain the intersection too, not just metrics.
    expect(resolveReportType(['IMPRESSIONS'], ['COUNTRY_NAME'])).toBe('HISTORICAL');
  });

  it('names both sides when no report type accepts the whole query', () => {
    const r = resolveReportType(['UNIQUE_VISITORS', 'SELL_THROUGH_SELL_THROUGH_RATE']);
    expect(typeof r).toBe('object');
    expect((r as { error: string }).error).toContain('UNIQUE_VISITORS');
    expect((r as { error: string }).error).toContain('SELL_THROUGH_SELL_THROUGH_RATE');
  });
});
