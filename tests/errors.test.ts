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
});
