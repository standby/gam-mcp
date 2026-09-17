import { describe, it, expect, vi } from 'vitest';
import { connectHttp } from '../src/http-transport.js';
import { buildMcpServer } from '../src/server.js';
import { createReportCache } from '../src/cache.js';
import { createUsageCounters, instrumentGamClient } from '../src/usage.js';
import { makeCtx, NETWORK } from './helpers.js';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

const call = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: {
    name: 'run_report',
    arguments: { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'], date_range: { start: '2026-09-01', end: '2026-09-02' } },
  },
});

function post(port: number, payload: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });
}

// The stateless transport answers a call with one SSE message event.
async function toolResult(res: Response): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const text = await res.text();
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error(`no data line in: ${text}`);
  return JSON.parse(data.slice('data: '.length)).result;
}

describe('HTTP client disconnect (spec §2.6)', () => {
  it('F5: polling continues after the client goes away, and the next call is a cache hit', async () => {
    const polling = gate();
    const release = gate();
    const abort = new AbortController();
    const reportCache = createReportCache();
    const counters = createUsageCounters();
    const ctx = makeCtx(
      { reports: [{ query: { dimensions: ['AD_UNIT_ID'], metrics: ['IMPRESSIONS'] }, rows: [{ AD_UNIT_ID: 1, IMPRESSIONS: 5 }] }] },
      {
        reportCache,
        // The first wait between polls holds until the test lets GAM finish.
        sleep: async () => { polling.open(); await release.opened; },
      },
    );
    ctx.client = instrumentGamClient(ctx.client, counters);
    const handle = await connectHttp(() => buildMcpServer(ctx, { networkCode: NETWORK }), { port: 0, logger: ctx.logger });
    try {
      const first = post(handle.port, call(1), abort.signal).then((r) => r.text()).catch(() => 'aborted');
      await polling.opened; // the run is between two polls
      abort.abort();
      await first;
      release.open(); // GAM finishes; nobody is listening
      await vi.waitFor(() => expect(reportCache.size()).toBe(1), { timeout: 5000 });

      const second = await toolResult(await post(handle.port, call(2)));
      expect(second.isError).toBeFalsy();
      expect(JSON.parse(second.content[0].text).provenance).toMatchObject({ cache: { hit: true } });
      expect(counters.report_jobs_created).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
