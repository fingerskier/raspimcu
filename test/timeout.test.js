import { describe, it, expect } from 'vitest';
import { normalizeTimeout } from '../lib/timeout.js';

describe('timeout validation', () => {
  it('normalizes bounded integer milliseconds without coercion', () => {
    expect(normalizeTimeout(undefined, 10000)).toBe(10000);
    expect(normalizeTimeout(undefined)).toBeUndefined();
    for (const value of [1, 2147483647]) expect(normalizeTimeout(value)).toBe(value);
    for (const value of [null, '100', false, 0, -1, 1.5, NaN, Infinity, 2147483648]) {
      expect(() => normalizeTimeout(value)).toThrow(/timeout/i);
    }
  });
});
