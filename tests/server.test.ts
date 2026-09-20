import { describe, it, expect } from 'vitest';
import { listToolNames, installStdoutGuard } from '../src/server.js';
import { SAVED_QUERY_TOOLS } from './tool-table.js';

describe('server registry', () => {
  it('lists all expected tool names', () => {
    const names = listToolNames();
    expect(names.sort()).toEqual([
      'ad_speed',
      'bidder_breakdown',
      'compare_periods',
      'consent_messaging',
      'delete_saved_query',
      'describe_line_item',
      'describe_schema',
      'diagnose_fill_rate',
      'diagnose_floor_pricing',
      'fetch_report_page',
      'fill_rate',
      'find_anomalies',
      'find_unused_ad_units',
      'health_check',
      'inventory_breakdown',
      'kv_breakdown',
      'kv_report',
      'list_saved_queries',
      'lookup',
      'pacing_status',
      'reach_report',
      'revenue_summary',
      'revenue_trend',
      'run_report',
      'run_saved_query',
      'save_query',
      'sell_through',
      'top_advertisers',
      'top_line_items',
      'usage_stats',
      'video_breakdown',
      'viewability_breakdown',
      'yield_breakdown',
    ]);
  });

  it('HTTP mode lists every tool but the four saved-query tools', () => {
    expect(listToolNames('http').sort()).toEqual(
      listToolNames().filter((n) => !SAVED_QUERY_TOOLS.includes(n)).sort(),
    );
    expect(listToolNames('stdio')).toEqual(listToolNames());
  });

  it('stdout guard redirects writes to stderr', () => {
    const restore = installStdoutGuard();
    const errs: string[] = [];
    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      errs.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      process.stdout.write('SHOULD_GO_TO_STDERR\n');
    } finally {
      process.stderr.write = origErrWrite;
      restore();
    }
    expect(errs.join('')).toContain('SHOULD_GO_TO_STDERR');
  });
});
