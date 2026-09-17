import { describe, it, expect } from 'vitest';
import { hostnameOf } from '../src/parse.js';

describe('hostnameOf', () => {
  it.each([
    ['gam-mcp.internal', 'gam-mcp.internal'],
    ['GAM-MCP.Internal:8080', 'gam-mcp.internal'],
    ['127.0.0.1:3000', '127.0.0.1'],
    ['[::1]:3000', '[::1]'],
    ['bad host', null],
    ['', null],
  ])('%j names %j', (host, name) => {
    expect(hostnameOf(host)).toBe(name);
  });
});
