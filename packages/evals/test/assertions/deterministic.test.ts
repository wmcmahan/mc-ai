import { describe, it, expect } from 'vitest';
import {
  assertGreaterThanOrEqual,
  assertLessThanOrEqual,
  assertContainsAllKeys,
  assertSetEquals,
  assertStable,
  assertEqual,
} from '../../src/assertions/deterministic.js';

describe('assertGreaterThanOrEqual', () => {
  it('passes when actual >= threshold', () => {
    const result = assertGreaterThanOrEqual('ratio', 35, 30, 'compression ratio');
    expect(result.passed).toBe(true);
    expect(result.actual).toBe(35);
    expect(result.expected).toBe(30);
  });

  it('passes at exact boundary', () => {
    const result = assertGreaterThanOrEqual('ratio', 30, 30, 'exact match');
    expect(result.passed).toBe(true);
  });

  it('fails when actual < threshold', () => {
    const result = assertGreaterThanOrEqual('ratio', 25, 30, 'below threshold');
    expect(result.passed).toBe(false);
  });
});

describe('assertLessThanOrEqual', () => {
  it('passes when actual <= ceiling', () => {
    const result = assertLessThanOrEqual('budget', 3500, 4096, 'within budget');
    expect(result.passed).toBe(true);
  });

  it('passes at exact boundary', () => {
    const result = assertLessThanOrEqual('budget', 4096, 4096, 'exact budget');
    expect(result.passed).toBe(true);
  });

  it('fails when actual > ceiling', () => {
    const result = assertLessThanOrEqual('budget', 5000, 4096, 'over budget');
    expect(result.passed).toBe(false);
  });
});

describe('assertContainsAllKeys', () => {
  it('passes when all keys are present', () => {
    const output = 'name: Alice\nrole: researcher\nscore: 92';
    const result = assertContainsAllKeys('keys', output, ['name', 'role', 'score'], 'all keys');
    expect(result.passed).toBe(true);
    expect(result.actual).toBe(3);
  });

  it('fails when keys are missing', () => {
    const output = 'name: Alice\nscore: 92';
    const result = assertContainsAllKeys('keys', output, ['name', 'role', 'score'], 'missing key');
    expect(result.passed).toBe(false);
    expect(result.actual).toBe(2);
    expect(result.description).toContain('role');
  });

  it('passes with empty key list', () => {
    const result = assertContainsAllKeys('keys', 'anything', [], 'no keys');
    expect(result.passed).toBe(true);
  });
});

describe('assertSetEquals', () => {
  it('passes when sets are equal', () => {
    const actual = new Set(['a', 'b', 'c']);
    const expected = new Set(['a', 'b', 'c']);
    const result = assertSetEquals('entities', actual, expected, 'exact match');
    expect(result.passed).toBe(true);
  });

  it('fails when missing elements', () => {
    const actual = new Set(['a', 'b']);
    const expected = new Set(['a', 'b', 'c']);
    const result = assertSetEquals('entities', actual, expected, 'missing c');
    expect(result.passed).toBe(false);
    expect(result.description).toContain('missing: [c]');
  });

  it('fails when extra elements', () => {
    const actual = new Set(['a', 'b', 'c', 'd']);
    const expected = new Set(['a', 'b', 'c']);
    const result = assertSetEquals('entities', actual, expected, 'extra d');
    expect(result.passed).toBe(false);
    expect(result.description).toContain('extra: [d]');
  });

  it('reports both missing and extra', () => {
    const actual = new Set(['a', 'x']);
    const expected = new Set(['a', 'b']);
    const result = assertSetEquals('entities', actual, expected, 'mismatch');
    expect(result.passed).toBe(false);
    expect(result.description).toContain('missing: [b]');
    expect(result.description).toContain('extra: [x]');
  });
});

describe('assertStable', () => {
  it('passes when all results are identical', () => {
    const result = assertStable('determinism', [42, 42, 42], 'stable');
    expect(result.passed).toBe(true);
    expect(result.actual).toBe(1);
  });

  it('fails when results differ', () => {
    const result = assertStable('determinism', [42, 43, 42], 'unstable');
    expect(result.passed).toBe(false);
    expect(result.actual).toBe(2); // 2 distinct values
  });

  it('passes with single result', () => {
    const result = assertStable('determinism', [42], 'single');
    expect(result.passed).toBe(true);
  });

  it('handles complex objects', () => {
    const obj = { a: 1, b: [2, 3] };
    const result = assertStable('determinism', [obj, { ...obj }, { a: 1, b: [2, 3] }], 'objects');
    expect(result.passed).toBe(true);
  });
});

describe('assertEqual', () => {
  it('passes on exact match', () => {
    const result = assertEqual('count', 5, 5, 'exact');
    expect(result.passed).toBe(true);
  });

  it('fails on mismatch', () => {
    const result = assertEqual('count', 4, 5, 'off by one');
    expect(result.passed).toBe(false);
    expect(result.actual).toBe(4);
    expect(result.expected).toBe(5);
  });
});
