import { describe, it, expect } from 'vitest';
import { derivedEnvelope } from '../src/report-exec.js';
import { createFakeGam } from './fake-gam.js';
import { restCtx } from './helpers.js';

describe('derivedEnvelope', () => {
  it('§1.1: total_row_count is the pre-slice total, not the rows handed over', () => {
    const ctx = restCtx(createFakeGam(), { pageRows: 10 });
    const r = derivedEnvelope(ctx, {
      summary: 'three keys, one shown',
      inputs: [],
      rows: [{ k: 1 }],          // already sliced by the caller
      total_row_count: 3,        // the real total
    }) as Record<string, any>;
    expect(r.total_row_count).toBe(3);
    expect(r.returned_row_count).toBe(1);
    expect(r.truncated).toBe(false);
  });
});
