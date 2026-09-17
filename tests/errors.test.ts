import { describe, it, expect } from 'vitest';
import { gamError, isGamError } from '../src/errors.js';

describe('gamError', () => {
  it('builds a structured envelope with hint', () => {
    const e = gamError('ENTITY_NOT_FOUND', { entity_type: 'advertiser', query: 'Acme' });
    expect(e).toEqual({
      error: {
        code: 'ENTITY_NOT_FOUND',
        message: expect.stringContaining('No advertiser matched'),
        hint: expect.stringContaining('lookup'),
        details: { entity_type: 'advertiser', query: 'Acme' },
      },
    });
  });

  it('builds AMBIGUOUS_NAME with candidates', () => {
    const e = gamError('AMBIGUOUS_NAME', {
      entity_type: 'advertiser',
      query: 'Acme',
      candidates: [{ id: 1, name: 'Acme Corp' }, { id: 2, name: 'Acme Industries' }],
    });
    expect(e.error.code).toBe('AMBIGUOUS_NAME');
    expect(e.error.details.candidates).toHaveLength(2);
  });

  it('isGamError discriminates', () => {
    expect(isGamError(gamError('INTERNAL_ERROR', {}))).toBe(true);
    expect(isGamError({ rows: [] })).toBe(false);
  });

  it('renders the paging error codes', () => {
    expect(gamError('REPORT_RESULT_EXPIRED', { result: 'networks/1/reports/2/results/3' }).error.message)
      .toContain('networks/1/reports/2/results/3');
    const big = gamError('RESULT_TOO_LARGE', { rows: 60000, limit: 50000, what: 'input report' });
    expect(big.error.message).toBe('The input report has 60000 rows, over the limit of 50000.');
    expect(big.error.hint).toMatch(/Narrow/);
  });
});
