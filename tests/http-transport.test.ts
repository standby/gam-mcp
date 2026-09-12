import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { _internal, connectHttp } from '../src/http-transport.js';
import type { Logger } from '../src/log.js';

// Build a minimal IncomingMessage-like object backed by a readable stream.
function fakeReq(method: string, body?: string): IncomingMessage {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(stream, { method, headers: {}, url: '/mcp' });
  return stream as unknown as IncomingMessage;
}

describe('http-transport readJsonBody', () => {
  it('returns undefined for GET (no body expected)', async () => {
    expect(await _internal.readJsonBody(fakeReq('GET'))).toBeUndefined();
  });

  it('parses a JSON body on POST', async () => {
    expect(await _internal.readJsonBody(fakeReq('POST', '{"hello":"world"}')))
      .toEqual({ hello: 'world' });
  });

  it('returns undefined for an empty POST', async () => {
    expect(await _internal.readJsonBody(fakeReq('POST', ''))).toBeUndefined();
  });

  it('throws a clear error for malformed JSON', async () => {
    await expect(_internal.readJsonBody(fakeReq('POST', 'not-json')))
      .rejects.toThrow(/not valid JSON/);
  });
});

// Regression: the server used to hoist one StreamableHTTPServerTransport out of
// the request handler. In stateless mode a transport is spent after its first
// request, so #1 returned 200 and every later request returned an empty 500 —
// silently, because the SDK writes that status itself without throwing, so the
// handler's catch never logged. /healthz kept returning 200 throughout, so
// container healthchecks reported the process healthy while /mcp was dead.
//
// The old suite only exercised readJsonBody, which is why this shipped. These
// tests drive real HTTP, and they must send MORE THAN ONE request: a
// single-request test passes against the bug.
describe('http-transport serves repeated requests', () => {
  const initialize = (id: number) => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'regression-test', version: '1' },
    },
  });

  const post = (port: number, payload: unknown) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(payload),
    });

  async function withServer(run: (port: number) => Promise<void>) {
    const silent: Logger = {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    } as unknown as Logger;
    const handle = await connectHttp(
      () => new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } }),
      { port: 0, logger: silent },
    );
    try {
      await run(handle.port);
    } finally {
      await handle.close();
    }
  }

  it('answers three sequential initialize requests, not just the first', async () => {
    await withServer(async (port) => {
      const statuses: number[] = [];
      for (let i = 1; i <= 3; i++) {
        const res = await post(port, initialize(i));
        statuses.push(res.status);
        await res.text(); // drain, so the response closes and its pair is released
      }
      expect(statuses).toEqual([200, 200, 200]);
    });
  });

  it('answers concurrent requests, each with its own transport', async () => {
    await withServer(async (port) => {
      const responses = await Promise.all([1, 2, 3, 4].map((i) => post(port, initialize(i))));
      const statuses = responses.map((r) => r.status);
      await Promise.all(responses.map((r) => r.text()));
      expect(statuses).toEqual([200, 200, 200, 200]);
    });
  });

  it('keeps /healthz and unknown-path handling intact', async () => {
    await withServer(async (port) => {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

      const missing = await fetch(`http://127.0.0.1:${port}/nope`, { method: 'POST', body: '{}' });
      expect(missing.status).toBe(404);
      await missing.text();
    });
  });
});
