import { describe, it, expect } from 'vitest';
import { buildMcpServer } from '../src/server.js';
import type { TransportMode } from '../src/tools/index.js';
import { connectClient, payloadOf } from './helpers.js';
import { ANNOTATIONS, argsFor, SAVED_QUERY_TOOLS, toolWorld } from './tool-table.js';

async function listed(mode: TransportMode) {
  const client = await connectClient(buildMcpServer(toolWorld(), { mode }));
  return { client, tools: (await client.listTools()).tools };
}

describe('H2: every tool declares its annotations, in both modes (spec §3.4)', () => {
  it('the table covers exactly the stdio tools', async () => {
    const { tools } = await listed('stdio');
    expect(Object.keys(ANNOTATIONS).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it.each(['stdio', 'http'] as const)('%s', async (mode) => {
    const { tools } = await listed(mode);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, `${mode} ${tool.name}`).toBe('boolean');
      expect(tool.annotations, `${mode} ${tool.name}`).toEqual(ANNOTATIONS[tool.name]);
    }
  });
});

describe('H6: HTTP offers no saved queries (spec §3.5)', () => {
  it('HTTP lists none of the four, and calling one is an unknown tool', async () => {
    const { client, tools } = await listed('http');
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(Object.keys(ANNOTATIONS).length - SAVED_QUERY_TOOLS.length);
    for (const name of SAVED_QUERY_TOOLS) {
      expect(names).not.toContain(name);
      const r = await client.callTool({ name, arguments: argsFor(name) });
      expect(r.isError).toBe(true);
      expect(payloadOf(r).error).toMatchObject({ code: 'INVALID_INPUT', message: `Invalid input: Unknown tool ${name}.` });
    }
  });

  it('stdio lists all four with their annotations, and they work', async () => {
    const { client, tools } = await listed('stdio');
    for (const name of SAVED_QUERY_TOOLS) {
      expect(tools.find((t) => t.name === name)?.annotations).toEqual(ANNOTATIONS[name]);
    }
    expect(ANNOTATIONS.save_query).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(ANNOTATIONS.delete_saved_query).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(ANNOTATIONS.run_saved_query).toEqual({ readOnlyHint: true, openWorldHint: true });
    for (const name of SAVED_QUERY_TOOLS) {
      const r = await client.callTool({ name, arguments: argsFor(name) });
      expect(r.isError, `${name}: ${JSON.stringify(payloadOf(r))}`).toBeFalsy();
    }
  });
});
