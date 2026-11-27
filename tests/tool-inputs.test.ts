import { describe, it, expect, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../src/server.js';
import { ALL_TOOLS } from '../src/tools/index.js';
import type { JsonSchema } from '../src/json-schema.js';
import { connectClient, payloadOf } from './helpers.js';
import { argsFor, toolWorld, VALID_ARGS } from './tool-table.js';

let client: Client;
let listed: { name: string; inputSchema: JsonSchema }[];

beforeAll(async () => {
  client = await connectClient(buildMcpServer(toolWorld(), { mode: 'stdio' }));
  listed = (await client.listTools()).tools as typeof listed;
});

// Every place in a schema where fields are declared, with a path for messages.
function* objects(node: JsonSchema, path: string): Generator<{ path: string; node: JsonSchema }> {
  if (node.type === 'object') yield { path, node };
  for (const [key, child] of Object.entries((node.properties ?? {}) as Record<string, JsonSchema>)) {
    yield* objects(child, `${path}.${key}`);
  }
  for (const [i, branch] of ((node.anyOf ?? []) as JsonSchema[]).entries()) yield* objects(branch, `${path}|${i}`);
  if (node.items) yield* objects(node.items as JsonSchema, `${path}[]`);
}

describe('H1: every registered tool refuses an unknown key (spec §3.1)', () => {
  it('the table has a row for exactly the registered tools', () => {
    expect(Object.keys(VALID_ARGS).sort()).toEqual(listed.map((t) => t.name).sort());
  });

  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))('%s', async (name, tool) => {
    expect(tool.input.safeParse(argsFor(name)).success, `the table row for ${name} does not parse`).toBe(true);
    const r = await client.callTool({ name, arguments: { ...argsFor(name), not_a_field: 1 } });
    expect(r.isError).toBe(true);
    expect(payloadOf(r).error).toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid input: unknown key "not_a_field".' });
  });

  it('names an unknown key inside a nested object by its path', async () => {
    const args = argsFor('run_report');
    const inRange = await client.callTool({
      name: 'run_report',
      arguments: { ...args, date_range: { start: '2026-09-01', end: '2026-09-07', tz: 'UTC' } },
    });
    expect(payloadOf(inRange).error.message).toBe('Invalid input: date_range: unknown key "tz".');
    const inFilter = await client.callTool({
      name: 'run_report',
      arguments: { ...args, filters: [{ field: 'AD_UNIT_ID', value: 1, operator: 'IN' }] },
    });
    expect(payloadOf(inFilter).error.message).toBe('Invalid input: filters.0: unknown key "operator".');
  });

  it('advertises every object of every input as closed', () => {
    const open = listed.flatMap((t) => [...objects(t.inputSchema, t.name)])
      .filter(({ node }) => node.additionalProperties !== false)
      .map(({ path }) => path);
    expect(open).toEqual([]);
  });
});

describe('H5: every field of every advertised input has a description (spec §3.1)', () => {
  it('lists no field without one', () => {
    const missing = listed.flatMap((t) => [...objects(t.inputSchema, t.name)])
      .flatMap(({ path, node }) => Object.entries((node.properties ?? {}) as Record<string, JsonSchema>)
        .filter(([, field]) => typeof field.description !== 'string' || field.description.trim() === '')
        .map(([key]) => `${path}.${key}`));
    expect(missing).toEqual([]);
  });

  it('advertises date fields as dates', () => {
    const range = listed.find((t) => t.name === 'run_report')!.inputSchema as any;
    expect(range.properties.date_range.anyOf[0].properties.start).toMatchObject({ type: 'string', format: 'date' });
  });
});

// Every array a tool accepts must be bounded: zod accumulates one issue per
// failing element with no cap (GHSA-mrhx-c7xc-m3w5), so an unbounded array is a
// memory-exhaustion vector until zod is upgraded to v4.
function* arrays(node: JsonSchema, path: string): Generator<{ path: string; node: JsonSchema }> {
  if (node.type === 'array') yield { path, node };
  for (const [key, child] of Object.entries((node.properties ?? {}) as Record<string, JsonSchema>)) {
    yield* arrays(child, `${path}.${key}`);
  }
  for (const [i, branch] of ((node.anyOf ?? []) as JsonSchema[]).entries()) yield* arrays(branch, `${path}|${i}`);
  if (node.items) yield* arrays(node.items as JsonSchema, `${path}[]`);
}

describe('every array input has a maximum length', () => {
  it('advertises maxItems on every array of every tool', () => {
    const unbounded = listed.flatMap((t) =>
      [...arrays(t.inputSchema, t.name)].filter((a) => a.node.maxItems === undefined).map((a) => a.path),
    );
    expect(unbounded).toEqual([]);
  });
  it('rejects an oversized array before any GAM call', async () => {
    const res = await client.callTool({ name: 'lookup', arguments: { ...argsFor('lookup'), ids: Array.from({ length: 501 }, (_, i) => i + 1) } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(payloadOf(res))).toContain('INVALID_INPUT');
  });
});
