import { describe, it, expect } from 'vitest';
import { request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { connectHttp, HttpListenError, MAX_BODY_BYTES, type HttpOptions } from '../src/http-transport.js';
import { createLogger } from '../src/log.js';

const TOKEN = 'test-token-7Qx9-not-a-real-secret';
const WRONG = 'wrong-token-3Kd1';

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'boundary-test', version: '1' } },
});

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// A raw request, so the Host header and the body framing are the test's to choose.
function send(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
    const req = request({
      host: '127.0.0.1',
      port,
      method: opts.method ?? 'POST',
      path: opts.path ?? '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(body && !opts.chunked && { 'content-length': String(body.length) }),
        ...opts.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // The server may answer and close before a refused body is fully sent.
    req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? undefined : reject(e)));
    if (body && opts.chunked) {
      // Written in pieces without a length, so the server only learns the size by reading.
      for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.subarray(i, i + 64 * 1024));
    } else if (body) {
      req.write(body);
    }
    req.end();
  });
}

function recorder() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (l) => { lines.push(l); } });
  return { logger, lines, events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

async function withServer(options: Omit<HttpOptions, 'port' | 'logger'>, run: (port: number, log: ReturnType<typeof recorder>) => Promise<void>) {
  const log = recorder();
  const handle = await connectHttp(
    () => new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } }),
    { port: 0, logger: log.logger, ...options },
  );
  try {
    await run(handle.port, log);
  } finally {
    await handle.close();
  }
}

describe('bearer token (spec §2.7)', () => {
  it('G1: with a token set, a request without it or with another is 401; with it, 200', async () => {
    await withServer({ bearerToken: TOKEN }, async (port, log) => {
      const missing = await send(port, { body: initialize });
      expect(missing.status).toBe(401);
      expect(missing.headers['www-authenticate']).toBe('Bearer');
      expect(JSON.parse(missing.body)).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null });

      for (const authorization of [`Bearer ${WRONG}`, `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`, 'Bearer', '']) {
        expect((await send(port, { body: initialize, headers: { authorization } })).status, authorization).toBe(401);
      }
      expect((await send(port, { path: '/elsewhere', body: '{}' })).status).toBe(401);

      expect((await send(port, { body: initialize, headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
      expect((await send(port, { body: initialize, headers: { authorization: `bearer  ${TOKEN}` } })).status).toBe(200);

      expect(log.events().filter((e) => e.msg === 'http.refused').map((e) => e.reason)).toContain('no bearer token');
      expect(log.lines.join('')).not.toContain(TOKEN);
      expect(log.lines.join('')).not.toContain(WRONG);
    });
  });

  it('G2: /healthz answers without a token and says only that the server is up', async () => {
    await withServer({ bearerToken: TOKEN, allowedHosts: ['gam-mcp.internal'] }, async (port) => {
      const health = await send(port, { method: 'GET', path: '/healthz' });
      expect(health.status).toBe(200);
      expect(health.body).toBe('{"status":"ok"}');
    });
  });

  it('G3: without a token the server warns once, at startup, and serves', async () => {
    await withServer({}, async (port, log) => {
      for (let i = 0; i < 3; i++) expect((await send(port, { body: initialize })).status).toBe(200);
      expect(log.events().filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual(['http.unauthenticated']);
    });
    await withServer({ bearerToken: TOKEN }, async (_port, log) => {
      expect(log.events().map((e) => e.msg)).not.toContain('http.unauthenticated');
    });
  });
});

describe('every refusal gives the connection back (spec §2.7)', () => {
  // The 413 path was hardened for this and its three siblings were not: a
  // refusal is a request this server never reads, so a client that declares a
  // body and stops sending leaves the socket waiting for bytes nobody wants,
  // and a well-formed request on that same connection is never answered.
  const CASES = [
    ['403 host not allowed', { allowedHosts: ['gam-mcp.internal'] } as const, '/mcp', 'evil.example', '403'],
    ['401 wrong token', { bearerToken: TOKEN } as const, '/mcp', '127.0.0.1', '401'],
    ['404 unknown path', {} as const, '/nope', '127.0.0.1', '404'],
  ] as const;

  it.each(CASES)('%s closes the connection when the declared body never arrives', { timeout: 20000 }, async (_label, options, path, host, status) => {
    await withServer(options, async (port) => {
      const sock = connect(port, '127.0.0.1');
      await once(sock, 'connect');
      let reply = '';
      sock.on('data', (c: Buffer) => { reply += c.toString('utf8'); });
      sock.write(
        `POST ${path} HTTP/1.1\r\nhost: ${host}\r\ncontent-type: application/json\r\n` +
        `authorization: Bearer ${WRONG}\r\ncontent-length: 5000\r\n\r\n` + 'x'.repeat(100),
      );
      const closed = await Promise.race([
        once(sock, 'close').then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
      ]);
      sock.destroy();
      expect(reply).toContain(status);
      // Under 4s on purpose: Node's own keep-alive timeout would close an idle
      // socket at 5s, so a laxer bound would pass with the drain removed.
      expect(closed, 'the refused connection was left open, so the next request on it would hang').toBe(true);
    });
  });

  it('an unknown path is refused in the same shape as every other refusal', async () => {
    await withServer({}, async (port) => {
      const r = await send(port, { path: '/nope', body: initialize });
      expect(r.status).toBe(404);
      expect(r.headers['content-type']).toContain('application/json');
      expect(JSON.parse(r.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000, message: 'Not found' }, id: null });
    });
  });
});

describe('request size (spec §2.7)', () => {
  const big = JSON.stringify({ padding: 'x'.repeat(1.1 * 1024 * 1024) });

  it('G4: a 1.1 MB body is 413, and the next request on the server succeeds', async () => {
    await withServer({ bearerToken: TOKEN }, async (port) => {
      const auth = { authorization: `Bearer ${TOKEN}` };
      const refused = await send(port, { body: big, headers: auth });
      expect(refused.status).toBe(413);
      expect(JSON.parse(refused.body).error.message).toBe(`Request body is over ${MAX_BODY_BYTES} bytes`);
      expect((await send(port, { body: initialize, headers: auth })).status).toBe(200);
    });
  });

  it('G4: a declared length over the limit closes the connection, even if the body never arrives', { timeout: 20000 }, async () => {
    await withServer({}, async (port) => {
      const sock = connect(port, '127.0.0.1');
      await once(sock, 'connect');
      let reply = '';
      sock.on('data', (c: Buffer) => { reply += c.toString('utf8'); });
      // Declares far more than it sends, and then stops: the server has refused
      // to read this body, so it must not wait for the rest of it.
      sock.write(
        'POST /mcp HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\n' +
        `content-length: ${MAX_BODY_BYTES + 1000}\r\n\r\n` + 'x'.repeat(1000),
      );
      const closed = await Promise.race([
        once(sock, 'close').then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
      ]);
      sock.destroy();
      expect(reply).toContain('413');
      expect(closed, 'the refused connection was left open').toBe(true);
    });
  });

  it('G4: a body sent without a length is refused where it passes the limit', async () => {
    await withServer({}, async (port) => {
      const refused = await send(port, { body: big, chunked: true });
      expect(refused.status).toBe(413);
      expect(refused.headers.connection).toBe('close');
      expect((await send(port, { body: initialize })).status).toBe(200);
    });
  });

  it('a body of exactly the limit is read', async () => {
    await withServer({}, async (port) => {
      const exact = initialize.padEnd(MAX_BODY_BYTES, ' ');
      expect((await send(port, { body: exact })).status).toBe(200);
    });
  });
});

describe('allowed hosts (spec §2.7)', () => {
  it('G5: with hosts set, a request naming another host is 403, whatever the port', async () => {
    await withServer({ allowedHosts: ['gam-mcp.internal', '127.0.0.1'] }, async (port, log) => {
      const foreign = await send(port, { body: initialize, headers: { host: 'attacker.example' } });
      expect(foreign.status).toBe(403);
      expect(JSON.parse(foreign.body).error.message).toBe('Host not allowed');
      expect((await send(port, { body: initialize, headers: { host: 'gam-mcp.internal.attacker.example' } })).status).toBe(403);
      expect((await send(port, { body: initialize, headers: { host: 'bad host' } })).status).toBe(403);
      expect((await send(port, { body: initialize, headers: { host: 'GAM-MCP.internal:8080' } })).status).toBe(200);
      expect((await send(port, { body: initialize })).status).toBe(200); // Host: 127.0.0.1:<port>
      expect(log.events().find((e) => e.msg === 'http.refused')).toMatchObject({ status: 403, host: 'attacker.example' });
    });
  });

  it('G5: the host is checked before the token', async () => {
    await withServer({ allowedHosts: ['gam-mcp.internal'], bearerToken: TOKEN }, async (port) => {
      const r = await send(port, { body: initialize, headers: { host: 'attacker.example', authorization: `Bearer ${TOKEN}` } });
      expect(r.status).toBe(403);
    });
  });

  it('G5: without hosts set, any Host is served', async () => {
    await withServer({}, async (port) => {
      expect((await send(port, { body: initialize, headers: { host: 'attacker.example' } })).status).toBe(200);
    });
  });
});

describe('listening (PR 2 review)', () => {
  it('a port already in use is an HttpListenError naming GAM_HTTP_PORT', async () => {
    await withServer({}, async (port) => {
      const log = recorder();
      const second = connectHttp(() => new Server({ name: 'test', version: '1' }, { capabilities: {} }), { port, logger: log.logger });
      await expect(second).rejects.toThrow(HttpListenError);
      await expect(second).rejects.toThrow(`GAM_HTTP_PORT ${port} is already in use by another process`);
      expect(log.events().map((e) => e.msg)).not.toContain('http.listening');
    });
  });
});
