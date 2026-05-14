import { describe, it, expect } from 'vitest';
import { GAM_SCHEMA, isValidDimension, isValidMetric, validateCombo } from '../src/schema.js';

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

  it('exposes key-value and per-slot custom-dimension dimensions', () => {
    expect(isValidDimension('KEY_VALUES_NAME')).toBe(true);
    expect(isValidDimension('KEY_VALUES_ID')).toBe(true);
    for (let i = 0; i <= 9; i++) {
      expect(isValidDimension(`CUSTOM_DIMENSION_${i}_VALUE`)).toBe(true);
    }
  });

  it('exposes content-taxonomy dimensions (PPS-adjacent)', () => {
    expect(isValidDimension('TAXONOMY_CATEGORY')).toBe(true);
    expect(isValidDimension('TAXONOMY_CATEGORY_ID')).toBe(true);
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
});
