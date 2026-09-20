import { describe, it, expect } from 'vitest';
import { hostnameOf, wholeNumber } from '../src/parse.js';

describe('wholeNumber (PR 2 review)', () => {
  it.each([['0', 0], ['8080', 8080], ['0300000', 300000]])('reads %j', (raw, n) => {
    expect(wholeNumber(raw)).toBe(n);
  });

  it.each(['', ' 5', '5 ', '1e3', '0x10', '5.0', '-1', '+1', 'ten', '99999999999999999999'])('refuses %j', (raw) => {
    expect(wholeNumber(raw)).toBeNull();
  });
});

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
