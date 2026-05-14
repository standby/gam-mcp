import { describe, it, expect } from 'vitest';
import { listToolNames, installStdoutGuard } from '../src/server.js';

describe('server registry', () => {
  it('lists all expected tool names', () => {
    const names = listToolNames();
    expect(names.sort()).toEqual([
      'compare_periods',
      'describe_schema',
      'fill_rate',
      'find_anomalies',
      'inventory_breakdown',
      'kv_breakdown',
      'lookup',
      'pacing_status',
      'revenue_summary',
      'revenue_trend',
      'run_report',
      'top_advertisers',
      'top_line_items',
    ]);
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
