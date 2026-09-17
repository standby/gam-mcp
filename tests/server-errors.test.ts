import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server.js';
import { gamError, type GamErrorCode } from '../src/errors.js';
import type { ToolDefinition } from '../src/report-tool-builder.js';
import { createLogger } from '../src/log.js';
import { connectClient, makeCtx } from './helpers.js';

const CODES: GamErrorCode[] = [
  'INVALID_DATE_RANGE', 'INVALID_INPUT', 'AUTH_FAILED', 'QUOTA_EXCEEDED', 'REPORT_FAILED',
  'REPORT_TIMEOUT', 'ENTITY_NOT_FOUND', 'AMBIGUOUS_NAME', 'UNSUPPORTED_DIMENSION_COMBO',
  'INTERNAL_ERROR', 'REPORT_RESULT_EXPIRED', 'RESULT_TOO_LARGE',
];

const returnsError: ToolDefinition<z.ZodTypeAny> = {
  name: 'returns_error',
  description: 'test',
  input: z.object({ code: z.string() }),
  handler: async (input) => gamError(input.code as GamErrorCode, {}),
};
const throws: ToolDefinition<z.ZodTypeAny> = {
  name: 'throws',
  description: 'test',
  input: z.object({}),
  handler: async () => { throw new Error('boom'); },
};
const strict: ToolDefinition<z.ZodTypeAny> = {
  name: 'strict',
  description: 'test',
  input: z.object({ n: z.number().describe('A number.') }).strict(),
  handler: async () => ({ summary: 'ok' }),
};
const fine: ToolDefinition<z.ZodTypeAny> = {
  name: 'fine',
  description: 'test',
  input: z.object({ n: z.number() }),
  handler: async () => ({ summary: 'ok' }),
};

async function connect() {
  const server = buildMcpServer(makeCtx(), { mode: 'stdio', tools: [returnsError, throws, fine, strict] });
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
    ['fine', { n: 1 }, true],
  ])('a call to %s with %j logs one start and one end line', async (name, args, ok) => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => { lines.push(JSON.parse(l)); } });
    const server = buildMcpServer(makeCtx({}, { logger }), { mode: 'stdio', tools: [returnsError, throws, fine, strict] });
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
