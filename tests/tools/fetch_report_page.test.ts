import { describe, it, expect } from 'vitest';
import { fetchReportPageTool } from '../../src/tools/fetch_report_page.js';
import { makeCtx } from '../helpers.js';

describe('fetch_report_page', () => {
  it('rejects an empty cursor at the schema', () => {
    expect(fetchReportPageTool.input.safeParse({ cursor: '' }).success).toBe(false);
  });

  it('returns INVALID_INPUT for a cursor that is not ours', async () => {
    expect(await fetchReportPageTool.handler({ cursor: 'xyz' }, makeCtx()))
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });
});
