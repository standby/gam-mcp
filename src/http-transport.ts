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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Logger } from './log.js';

export async function connectHttp(
  // A factory, not a server: one instance cannot be reused across requests.
  createMcpServer: () => Server,
  opts: { port: number; logger: Logger },
): Promise<{ port: number; close: () => Promise<void> }> {
  const httpServer = createServer(async (req, res) => {
    // Health endpoint without authentication so probes don't pollute logs
    // with auth failures. Returns 200 if the process is up.
    if (req.url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
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
    httpServer.once('error', reject);
    httpServer.listen(opts.port, () => {
      opts.logger.info('http.listening', { port: opts.port, endpoint: '/mcp' });
      resolve();
    });
  });

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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // GET requests have no body (SSE streams open on GET).
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('request body is not valid JSON');
  }
}

// Provided for unit testing — never used by the HTTP listener itself.
// Kept here so the body-reading edge cases are testable without spinning
// up a real server.
export const _internal = { readJsonBody };

// Make ServerResponse type accessible for handlers without an extra import.
export type { ServerResponse };
