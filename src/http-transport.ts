// HTTP/SSE transport for hosted deployment. Opt-in via GAM_HTTP_PORT env var;
// when unset (default), the MCP runs over stdio exactly as before.
//
// Uses the SDK's StreamableHTTPServerTransport in stateless mode (no session
// IDs) — each request is logically independent and there's no in-flight
// state worth persisting across requests.
//
// Stateless means a NEW server and transport per request. A single transport
// hoisted out of the request handler is spent once its first request finishes:
// every later request then fails, and the SDK writes that 500 itself without
// throwing, so nothing reaches the catch below and nothing is logged. That was
// the shape of the bug fixed in 0.5.2 — see the regression test, which asserts
// several sequential requests rather than one.
//
// The boundary (spec §2.7) is checked here, before a request reaches the SDK:
// the Host header, then the bearer token, then the body size. The SDK 1.30
// transport's own allowedHosts / enableDnsRebindingProtection options are
// deprecated in favour of middleware and compare the whole Host header, port
// included, so this file checks the host name the way the SDK's
// hostHeaderValidation middleware does.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Logger } from './log.js';
import { hostnameOf } from './parse.js';

// The largest request body served; a larger one is answered 413.
export const MAX_BODY_BYTES = 1024 * 1024;

export type HttpOptions = {
  port: number;
  logger: Logger;
  // When set, every request but /healthz must carry `Authorization: Bearer <token>`.
  bearerToken?: string;
  // When set, a request whose Host header names another host is refused.
  // Lower-case host names without ports.
  allowedHosts?: string[];
};

// The port could not be listened on. The message names GAM_HTTP_PORT.
export class HttpListenError extends Error {
  constructor(readonly port: number, readonly code: string) {
    super(
      code === 'EADDRINUSE'
        ? `GAM_HTTP_PORT ${port} is already in use by another process`
        : `GAM_HTTP_PORT ${port} cannot be listened on (${code})`,
    );
    this.name = 'HttpListenError';
  }
}

class BodyTooLargeError extends Error {
  constructor(readonly whileReading: boolean) {
    super(`request body is over ${MAX_BODY_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

// Whether an Authorization header carries this token. Both sides are hashed
// first, so tokens of different lengths are compared without throwing and in
// the same time as equal-length ones.
function tokenCheck(expected: string): (header: string | undefined) => boolean {
  const want = createHash('sha256').update(expected).digest();
  return (header) => {
    const [scheme, token, ...rest] = (header ?? '').split(' ').filter((part) => part !== '');
    if (scheme?.toLowerCase() !== 'bearer' || token === undefined || rest.length > 0) return false;
    return timingSafeEqual(createHash('sha256').update(token).digest(), want);
  };
}

// A JSON-RPC error body, as the SDK writes its own refusals.
function refuse(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export async function connectHttp(
  // A factory, not a server: one instance cannot be reused across requests.
  createMcpServer: () => Server,
  opts: HttpOptions,
): Promise<{ port: number; close: () => Promise<void> }> {
  const authorized = opts.bearerToken === undefined ? null : tokenCheck(opts.bearerToken);
  const httpServer = createServer(async (req, res) => {
    // Health endpoint without authentication or a Host check, so probes that
    // address the container directly work. It says nothing but "up".
    if (req.url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (opts.allowedHosts) {
      const host = req.headers.host;
      const name = host === undefined ? null : hostnameOf(host);
      if (name === null || !opts.allowedHosts.includes(name)) {
        opts.logger.warn('http.refused', { status: 403, reason: 'host not allowed', host: host ?? null });
        refuse(res, 403, 'Host not allowed');
        return;
      }
    }
    if (authorized && !authorized(req.headers.authorization)) {
      // Never log the header: it may hold a real token for something else.
      const reason = req.headers.authorization === undefined ? 'no bearer token' : 'wrong bearer token';
      opts.logger.warn('http.refused', { status: 401, reason });
      refuse(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
      return;
    }
    if (req.url !== '/mcp' && req.url !== '/mcp/') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let server: Server | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const body = await readJsonBody(req);
      server = createMcpServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        opts.logger.warn('http.refused', { status: 413, reason: e.message });
        // A body cut off part-way cannot be drained, so that connection closes.
        refuse(res, 413, `Request body is over ${MAX_BODY_BYTES} bytes`, e.whileReading ? { connection: 'close' } : {});
        return;
      }
      opts.logger.error('http.handle_error', { message: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    } finally {
      // Release this request's pair once the response is done. Closing earlier
      // would cut off a streaming (SSE) response mid-flight.
      const release = () => {
        void transport?.close().catch(() => {});
        void server?.close().catch(() => {});
      };
      if (res.writableEnded) release();
      else res.once('close', release);
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (e: NodeJS.ErrnoException) => reject(new HttpListenError(opts.port, e.code ?? 'unknown error')));
    httpServer.listen(opts.port, () => {
      opts.logger.info('http.listening', { port: opts.port, endpoint: '/mcp' });
      resolve();
    });
  });
  if (authorized === null) {
    opts.logger.warn('http.unauthenticated', {
      reason: 'GAM_HTTP_BEARER_TOKEN is not set, so every request to /mcp is served without authentication',
    });
  }

  const shutdown = () => {
    opts.logger.info('http.shutdown');
    httpServer.close(() => process.exit(0));
    // Hard exit if shutdown hangs (held-open SSE streams etc).
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : opts.port;

  return {
    // The port actually bound, which differs from opts.port when 0 is passed.
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        httpServer.close(() => resolve());
      }),
  };
}

// Reads and parses a request body of at most MAX_BODY_BYTES. A declared
// length over the limit is refused before reading, so Node discards the body
// and the connection stays usable; a body that grows past the limit is
// refused where it crosses it.
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // GET requests have no body (SSE streams open on GET).
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(undefined);
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
    return Promise.reject(new BodyTooLargeError(false));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off('data', onData);
        req.off('end', onEnd);
        req.pause();
        reject(new BodyTooLargeError(true));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', reject);
  });
}

// Provided for unit testing — never used by the HTTP listener itself.
// Kept here so the body-reading edge cases are testable without spinning
// up a real server.
export const _internal = { readJsonBody };

// Make ServerResponse type accessible for handlers without an extra import.
export type { ServerResponse };
