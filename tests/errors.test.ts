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

  it('REPORT_RESULT_EXPIRED says to run the tool again, or to re-run the tool behind a cursor', () => {
    const direct = gamError('REPORT_RESULT_EXPIRED', { result: 'networks/1/reports/2/results/3' }).error.hint;
    expect(direct).toMatch(/^Run the tool again/);
    expect(direct).not.toContain('cursor');
    const paged = gamError('REPORT_RESULT_EXPIRED', { result: 'networks/1/reports/2/results/3', from_cursor: true }).error.hint;
    expect(paged).toBe('Re-run the tool that produced this cursor; GAM keeps report results for a limited time.');
  });

  it('REPORT_TIMEOUT names the operation and says the next call waits for it', () => {
    const e = gamError('REPORT_TIMEOUT', { timeout_ms: 90000, operation: 'networks/1/operations/reports/runs/2' });
    expect(e.error.message).toBe('Report did not finish within 90000ms (operation networks/1/operations/reports/runs/2).');
    expect(e.error.hint).toContain('the same call');
    expect(e.error.hint).toContain('GAM_REPORT_TIMEOUT_MS');
  });
});
