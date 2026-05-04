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
});
