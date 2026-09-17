import { describe, it, expect } from 'vitest';
import { buildMcpServer, listResources } from '../src/server.js';
import { connectClient, makeCtx } from './helpers.js';
import { PROMPTS, renderPrompt } from '../src/prompts.js';

describe('resources', () => {
  it('exposes schema, dimensions, and metrics URIs', () => {
    const uris = listResources().map((r) => r.uri).sort();
    expect(uris).toEqual([
      'gam://schema',
      'gam://schema/dimensions',
      'gam://schema/metrics',
    ]);
  });

  it('gam://network names the network, its currency and both time zones (PR 2 review)', async () => {
    const client = await connectClient(buildMcpServer(makeCtx({}, { timezone: 'Asia/Seoul' }), { mode: 'http' }));
    const { contents } = await client.readResource({ uri: 'gam://network' });
    expect(JSON.parse(contents[0].text as string)).toEqual({
      network_code: '1234',
      currency_code: 'USD',
      report_time_zone: 'Asia/Tokyo',
      date_time_zone: 'Asia/Seoul',
    });
  });

  it('each resource body is JSON-serializable', () => {
    for (const r of listResources()) {
      expect(() => JSON.stringify(r.body())).not.toThrow();
    }
  });
});

describe('prompts', () => {
  it('exposes the three preset workflows', () => {
    expect(PROMPTS.map((p) => p.name).sort()).toEqual([
      'fill_rate_postmortem',
      'monthly_revenue_close',
      'weekly_pacing_review',
    ]);
  });

  it('weekly_pacing_review renders with default top_n', () => {
    const r = renderPrompt('weekly_pacing_review', {});
    expect(r?.text).toContain('top_n:20');
    expect(r?.text).toContain('pacing_underdelivery');
  });

  it('monthly_revenue_close honors month arg when YYYY-MM', () => {
    const r = renderPrompt('monthly_revenue_close', { month: '2026-03' });
    expect(r?.text).toContain('2026-03');
    expect(r?.text).not.toContain('last_full_month');
  });

  it('monthly_revenue_close falls back to last_full_month for bad input', () => {
    const r = renderPrompt('monthly_revenue_close', { month: 'last month' });
    expect(r?.text).toContain('last_full_month');
  });

  it('returns null for unknown prompt names', () => {
    expect(renderPrompt('does_not_exist', {})).toBeNull();
  });
});
