import { describe, it, expect } from 'vitest';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, connectStdio } from '../src/server.js';
import { connectHttp } from '../src/http-transport.js';
import { createReportCache } from '../src/cache.js';
import { createLogger } from '../src/log.js';
import type { ToolContext } from '../src/report-tool-builder.js';
import { createFakeGam, dbl, int, str } from './fake-gam.js';
import { NETWORK, payloadOf, restCtx } from './helpers.js';

// The owner's requirement: 0.6.0 works over both MCP transports. Each case
// drives the real server code through the real SDK transport, with the real
// REST client talking to the in-process fake GAM, and checks the four things
// a client does first: initialize, list tools, run a report, page through it.

const TOKEN = 'e2e-token-not-a-secret-5f2a';
const SAVED_QUERY_TOOLS = ['save_query', 'list_saved_queries', 'run_saved_query', 'delete_saved_query'];
const RUN = {
  dimensions: ['AD_UNIT_ID', 'AD_UNIT_NAME'],
  metrics: ['IMPRESSIONS', 'REVENUE'],
  date_range: { start: '2026-09-01', end: '2026-09-07' },
};

// Three rows served two to a page, so the report has a second page.
function world(): ToolContext {
  const gam = createFakeGam();
  gam.setRows({
    byColumn: [
      { AD_UNIT_ID: int(101), AD_UNIT_NAME: str('Home top'), IMPRESSIONS: int(1500), REVENUE: dbl(12.5) },
      { AD_UNIT_ID: int(102), AD_UNIT_NAME: str('Article side'), IMPRESSIONS: int(900), REVENUE: dbl(3.25) },
      { AD_UNIT_ID: int(103), AD_UNIT_NAME: str('Footer'), IMPRESSIONS: int(40), REVENUE: dbl(0.1) },
    ],
  });
  const logger = createLogger({ level: 'error', sink: () => {} });
  return restCtx(gam, { pageRows: 2, logger, reportCache: createReportCache({ networkCode: NETWORK, logger }) });
}

// The client end of a stdio connection: line-framed JSON-RPC written to the
// server's stdin and read from its stdout, as a client that started the
// server as a child process sees it.
class StreamClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();

  constructor(private readonly toServer: Writable, private readonly fromServer: Readable) {}

  async start(): Promise<void> {
    this.fromServer.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (let m = this.buffer.readMessage(); m !== null; m = this.buffer.readMessage()) this.onmessage?.(m);
      } catch (e) {
        this.onerror?.(e as Error);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.toServer.end();
    this.onclose?.();
  }
}

async function exercise(client: Client, mode: 'stdio' | 'http'): Promise<void> {
  expect(client.getServerVersion()?.name).toBe('gam-mcp');
  expect(client.getServerCapabilities()?.tools).toBeDefined();

  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain('run_report');
  expect(names).toContain('fetch_report_page');
  for (const name of SAVED_QUERY_TOOLS) {
    if (mode === 'stdio') expect(names).toContain(name);
    else expect(names).not.toContain(name);
  }
  expect(names).toHaveLength(mode === 'stdio' ? 33 : 29);

  const first = await client.callTool({ name: 'run_report', arguments: RUN });
  expect(first.isError, JSON.stringify(first.content)).toBeFalsy();
  const page1 = payloadOf(first);
  expect(page1.provenance).toMatchObject({
    network_code: NETWORK,
    report_type: 'HISTORICAL',
    report: `networks/${NETWORK}/reports/1`,
    result: `networks/${NETWORK}/reports/1/results/1`,
    date_range: { start: '2026-09-01', end: '2026-09-07' },
    report_time_zone: 'Asia/Tokyo',
    date_time_zone: 'Asia/Tokyo',
    currency_code: 'USD',
    dimensions: RUN.dimensions,
    metrics: RUN.metrics,
    cache: { hit: false },
  });
  expect(page1.schema).toEqual([
    { name: 'AD_UNIT_ID', type: 'integer' },
    { name: 'AD_UNIT_NAME', type: 'string' },
    { name: 'IMPRESSIONS', type: 'integer' },
    { name: 'REVENUE', type: 'number' },
  ]);
  expect(page1.rows).toEqual([
    { AD_UNIT_ID: 101, AD_UNIT_NAME: 'Home top', IMPRESSIONS: 1500, REVENUE: 12.5 },
    { AD_UNIT_ID: 102, AD_UNIT_NAME: 'Article side', IMPRESSIONS: 900, REVENUE: 3.25 },
  ]);
  expect(page1).toMatchObject({ total_row_count: 3, returned_row_count: 2, truncated: true });
  expect(page1.next_cursor).toEqual(expect.any(String));

  const second = await client.callTool({ name: 'fetch_report_page', arguments: { cursor: page1.next_cursor } });
  expect(second.isError, JSON.stringify(second.content)).toBeFalsy();
  const page2 = payloadOf(second);
  expect(page2.provenance).toMatchObject({ result: page1.provenance.result, report_time_zone: 'Asia/Tokyo' });
  expect(page2.rows).toEqual([{ AD_UNIT_ID: 103, AD_UNIT_NAME: 'Footer', IMPRESSIONS: 40, REVENUE: 0.1 }]);
  expect(page2).toMatchObject({ total_row_count: 3, returned_row_count: 1, truncated: false, next_cursor: null });
}

describe('both MCP transports, end to end (owner requirement)', () => {
  it('stdio: the stdio transport over in-process streams', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const server = await connectStdio(world(), { stdin, stdout });
    const client = new Client({ name: 'e2e-stdio', version: '1' });
    await client.connect(new StreamClientTransport(stdin, stdout));
    try {
      await exercise(client, 'stdio');
    } finally {
      await client.close();
      await server.close();
    }
    // stdout carries nothing but whole JSON-RPC messages, one per line.
    const text = written.join('');
    expect(text.endsWith('\n')).toBe(true);
    for (const line of text.slice(0, -1).split('\n')) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  });

  it('HTTP: connectHttp on an ephemeral port, with the bearer token', async () => {
    const ctx = world();
    const handle = await connectHttp(() => buildMcpServer(ctx, { mode: 'http' }), {
      port: 0,
      logger: ctx.logger,
      bearerToken: TOKEN,
      allowedHosts: ['127.0.0.1'],
    });
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    const client = new Client({ name: 'e2e-http', version: '1' });
    try {
      const refused = new Client({ name: 'e2e-http-no-token', version: '1' });
      await expect(refused.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();

      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }));
      await exercise(client, 'http');
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
