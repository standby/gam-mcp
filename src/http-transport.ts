// HTTP/SSE transport for hosted deployment. Opt-in via GAM_HTTP_PORT env var;
// when unset (default), the MCP runs over stdio exactly as before.
//
// Uses the SDK's StreamableHTTPServerTransport in stateless mode (no session
// IDs) — each request is logically independent and there's no in-flight
// state worth persisting across requests.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Logger } from './log.js';

export async function connectHttp(
  server: Server,
  opts: { port: number; logger: Logger },
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  await server.connect(transport);

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
    try {
      const body = await readJsonBody(req);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      opts.logger.error('http.handle_error', { message: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
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
