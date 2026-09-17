import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/server.js';
import { gamError, type GamErrorCode } from '../src/errors.js';
import type { ToolDefinition } from '../src/report-tool-builder.js';
import { makeCtx, NETWORK } from './helpers.js';

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
  const server = buildMcpServer(makeCtx(), { networkCode: NETWORK, tools: [returnsError, throws, fine, strict] });
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

  it('an unknown tool, invalid input and an exception have isError', async () => {
    const client = await connect();
    expect((await client.callTool({ name: 'nope', arguments: {} })).isError).toBe(true);
    expect((await client.callTool({ name: 'fine', arguments: { n: 'x' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'throws', arguments: {} })).isError).toBe(true);
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
