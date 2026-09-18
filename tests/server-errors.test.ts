import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server.js';
import { gamError, GAM_ERROR_CODES, type GamErrorCode } from '../src/errors.js';
import { READS_GAM, type ToolDefinition } from '../src/report-tool-builder.js';
import { createLogger } from '../src/log.js';
import { GamHttpError } from '../src/gam-client.js';
import { connectClient, makeCtx, payloadOf } from './helpers.js';

// Read from the catalogue, not hand-copied: a fourth copy of the code list
// would not have complained when DUPLICATE_JOIN_KEY was added, because tests
// are not typechecked (the same defect class as the stdio-only tool names in
// PR 3 Task 8).
const CODES: readonly GamErrorCode[] = GAM_ERROR_CODES;

const returnsError: ToolDefinition<z.ZodTypeAny> = {
  name: 'returns_error',
  description: 'test',
  input: z.object({ code: z.string() }),
  annotations: READS_GAM,
  handler: async (input) => gamError(input.code as GamErrorCode, {}),
};
const throws: ToolDefinition<z.ZodTypeAny> = {
  name: 'throws',
  description: 'test',
  input: z.object({}),
  annotations: READS_GAM,
  handler: async () => { throw new Error('boom'); },
};
const strict: ToolDefinition<z.ZodTypeAny> = {
  name: 'strict',
  description: 'test',
  input: z.object({ n: z.number().describe('A number.') }).strict(),
  annotations: READS_GAM,
  handler: async () => ({ summary: 'ok' }),
};
// A result the server cannot serialise: the failure happens after the handler
// returned, which is the one way a call could once be logged closed twice.
const unserializable: ToolDefinition<z.ZodTypeAny> = {
  name: 'unserializable',
  description: 'test',
  input: z.object({}),
  annotations: READS_GAM,
  handler: async () => ({ summary: 'ok', n: 1n } as unknown as { summary: string }),
};
const fine: ToolDefinition<z.ZodTypeAny> = {
  name: 'fine',
  description: 'test',
  input: z.object({ n: z.number() }),
  annotations: READS_GAM,
  handler: async () => ({ summary: 'ok' }),
};

async function connect() {
  const server = buildMcpServer(makeCtx(), { mode: 'stdio', tools: [returnsError, throws, fine, strict, unserializable] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('every error reaches the client flagged', () => {
  it.each(CODES)('a returned %s envelope has isError', async (code) => {
    const client = await connect();
    const r = await client.callTool({ name: 'returns_error', arguments: { code } });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as { text: string }[])[0].text).error.code).toBe(code);
  });

  it.each([
    ['an unknown tool', 'nope', {}, 'INVALID_INPUT', 'Invalid input: Unknown tool nope.'],
    ['invalid input', 'fine', { n: 'x' }, 'INVALID_INPUT', 'Invalid input: n: Expected number, received string.'],
    ['an exception', 'throws', {}, 'INTERNAL_ERROR', 'Internal error: boom.'],
  ])('%s has isError and its code', async (_label, name, args, code, message) => {
    const client = await connect();
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toEqual({
      error: { code, message, hint: expect.any(String), details: expect.any(Object) },
    });
  });

  it.each([
    ['nope', {}, false],
    ['fine', { n: 'x' }, false],
    ['returns_error', { code: 'REPORT_FAILED' }, false],
    ['throws', {}, false],
    ['unserializable', {}, false],
    ['fine', { n: 1 }, true],
  ])('a call to %s with %j logs one start and one end line', async (name, args, ok) => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => { lines.push(JSON.parse(l)); } });
    const server = buildMcpServer(makeCtx({}, { logger }), { mode: 'stdio', tools: [returnsError, throws, fine, strict, unserializable] });
    const client = await connectClient(server);
    await client.callTool({ name, arguments: args });
    const calls = lines.filter((l) => String(l.msg).startsWith('tool.call.'));
    expect(calls.map((l) => l.msg)).toEqual(ok ? ['tool.call.start', 'tool.call.end'] : ['tool.call.start', 'tool.call.error', 'tool.call.end']);
    expect(calls.at(-1)).toMatchObject({ tool: name, ok, duration_ms: expect.any(Number) });
  });

  it('a success does not', async () => {
    const client = await connect();
    expect((await client.callTool({ name: 'fine', arguments: { n: 1 } })).isError).toBeFalsy();
  });

  it('invalid input names the problem, and an unknown key by name', async () => {
    const client = await connect();
    const unknown = await client.callTool({ name: 'strict', arguments: { n: 1, m: 2 } });
    expect(unknown.isError).toBe(true);
    expect(JSON.parse((unknown.content as { text: string }[])[0].text).error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Invalid input: unknown key "m".',
    });
    const wrong = await client.callTool({ name: 'fine', arguments: { n: 'x' } });
    expect(JSON.parse((wrong.content as { text: string }[])[0].text).error.message)
      .toBe('Invalid input: n: Expected number, received string.');
  });

  // I12 (spec §4.7, F15): health_check caught its own failure and returned a
  // success envelope with status: 'failed' buried inside it, so a dead
  // credential looked like a passing call on the wire. This is asserted
  // through a real server, over the real transport -- isError is a
  // property of what the client receives, not of what a handler returns.
  it('I12: a failed health check arrives with isError and names the failing check', async () => {
    const ctx = makeCtx({}, {
      client: {
        ...makeCtx().client,
        listEntities: async () => { throw new GamHttpError('listEntities', 401, 'UNAUTHENTICATED', 'bad credentials'); },
      },
    });
    const server = buildMcpServer(ctx, { mode: 'stdio' });
    const client = await connectClient(server);
    const r = await client.callTool({ name: 'health_check', arguments: {} });
    expect(r.isError).toBe(true);
    const body = payloadOf(r);
    expect(body.error.code).toBe('AUTH_FAILED');
    // The diagnosis the old shape got right must survive into the error body.
    expect(JSON.stringify(body.error.details)).toMatch(/check/i);
    expect(body.error.details.check).toBe('listEntities');
  });

  it('advertises a strict input as closed', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'strict')?.inputSchema).toEqual({
      type: 'object',
      properties: { n: { description: 'A number.', type: 'number' } },
      required: ['n'],
      additionalProperties: false,
    });
  });
});
