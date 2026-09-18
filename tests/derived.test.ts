import { describe, it, expect } from 'vitest';
import { num, ratio, derived } from '../src/derived.js';

describe('num', () => {
  it('reads numbers and numeric strings', () => {
    expect(num(5)).toBe(5);
    expect(num('5.5')).toBe(5.5);
    expect(num(0)).toBe(0);
  });
  it('is null for absence, not zero', () => {
    for (const v of [null, undefined, '', '   ', 'abc', {}, []]) expect(num(v)).toBeNull();
  });
});

describe('ratio', () => {
  it('divides when both sides are known', () => {
    expect(ratio(1, 4)).toBe(0.25);
  });
  it('is null when either input is null', () => {
    expect(ratio(null, 4)).toBeNull();
    expect(ratio(1, null)).toBeNull();
  });
  it('is null for a zero denominator -- a zero denominator is not a zero rate', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(5, 0)).toBeNull();
  });
});

describe('derived', () => {
  it('always emits the same key order', () => {
    const d = derived({ method: 'x over y', heuristic: false, inputs: { x: 1, y: 2 }, value: 0.5 });
    expect(Object.keys(d)).toEqual(['value', 'method', 'heuristic', 'inputs']);
  });
});
