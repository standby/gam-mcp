import { describe, it, expect, beforeAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../src/server.js';
import { ALL_TOOLS } from '../src/tools/index.js';
import { connectClient, payloadOf } from './helpers.js';
import { argsFor, toolWorld } from './tool-table.js';

// Spec §1.1: everything that qualifies the rows is written before them.
const ENVELOPE = ['summary', 'provenance', 'total_row_count', 'returned_row_count', 'truncated', 'next_cursor', 'warnings', 'schema', 'rows'];
const PROVENANCE = [
  'network_code', 'report_type', 'report', 'result', 'run_time', 'date_range', 'report_time_zone',
  'date_time_zone', 'currency_code', 'dimensions', 'metrics', 'filters', 'sort', 'cache',
];
const DERIVED_PROVENANCE = ['network_code', 'report_time_zone', 'date_time_zone', 'currency_code', 'inputs'];

let client: Client;
let paged: Client;

beforeAll(async () => {
  client = await connectClient(buildMcpServer(toolWorld(), { mode: 'stdio' }));
  // One row per page, so run_report hands back a cursor for fetch_report_page.
  paged = await connectClient(buildMcpServer(toolWorld({ pageRows: 1 }), { mode: 'stdio' }));
});

async function call(name: string) {
  if (name !== 'fetch_report_page') return client.callTool({ name, arguments: argsFor(name) });
  const first = payloadOf(await paged.callTool({ name: 'run_report', arguments: argsFor('run_report') }));
  expect(first.next_cursor).toEqual(expect.any(String));
  return paged.callTool({ name, arguments: { cursor: first.next_cursor } });
}

describe('every tool writes its result in contract order, through the server (spec §1.1)', () => {
  it.each(ALL_TOOLS.map((t) => t.name))('%s', async (name) => {
    const r = await call(name);
    const body = payloadOf(r);
    expect(r.isError, JSON.stringify(body)).toBeFalsy();
    const keys = Object.keys(body);
    expect(keys[0]).toBe('summary');
    if ('rows' in body) {
      expect(keys).toEqual(ENVELOPE.filter((k) => k in body));
      if (body.provenance) {
        expect(Object.keys(body.provenance)).toEqual('inputs' in body.provenance ? DERIVED_PROVENANCE : PROVENANCE);
      }
    } else if ('warnings' in body) {
      expect(keys[1]).toBe('warnings');
    }
  });

  it('writes an error as { error: { code, message, hint, details } }', async () => {
    const r = await client.callTool({ name: 'run_report', arguments: { ...argsFor('run_report'), metrics: ['NOT_A_METRIC'] } });
    const body = payloadOf(r);
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error)).toEqual(['code', 'message', 'hint', 'details']);
  });
});
