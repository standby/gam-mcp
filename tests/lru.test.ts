import { describe, it, expect } from 'vitest';
import { Lru } from '../src/lru.js';

describe('Lru', () => {
  it('drops the least recently used entry beyond its bound', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // a is now the most recently used
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
  });

  it('refreshes an entry that is set again, and deletes', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('a', 10);
    lru.set('c', 3);
    expect(lru.get('a')).toBe(10);
    expect(lru.get('b')).toBeUndefined();
    lru.delete('a');
    expect(lru.get('a')).toBeUndefined();
    expect(lru.size).toBe(1);
  });
});
