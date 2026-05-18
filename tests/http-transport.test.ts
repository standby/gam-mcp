import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { _internal } from '../src/http-transport.js';

// Build a minimal IncomingMessage-like object backed by a readable stream.
function fakeReq(method: string, body?: string): IncomingMessage {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(stream, { method, headers: {}, url: '/mcp' });
  return stream as unknown as IncomingMessage;
}

describe('http-transport readJsonBody', () => {
  it('returns undefined for GET (no body expected)', async () => {
    expect(await _internal.readJsonBody(fakeReq('GET'))).toBeUndefined();
  });

  it('parses a JSON body on POST', async () => {
    expect(await _internal.readJsonBody(fakeReq('POST', '{"hello":"world"}')))
      .toEqual({ hello: 'world' });
  });

  it('returns undefined for an empty POST', async () => {
    expect(await _internal.readJsonBody(fakeReq('POST', ''))).toBeUndefined();
  });

  it('throws a clear error for malformed JSON', async () => {
    await expect(_internal.readJsonBody(fakeReq('POST', 'not-json')))
      .rejects.toThrow(/not valid JSON/);
  });
});
