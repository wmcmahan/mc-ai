import { describe, it, expect } from 'vitest';
import { applyCachePolicy, computePrefixHashes, measureCacheHitRate } from '../src/budget/cache-policy.js';
import type { PromptSegment } from '../src/pipeline/types.js';

function makeSegment(id: string, content: string, role: PromptSegment['role'], locked = false): PromptSegment {
  return { id, content, role, priority: 1, locked };
}

describe('applyCachePolicy', () => {
  it('locks system segments by default', () => {
    const segments = [
      makeSegment('sys', 'You are a helpful assistant.', 'system'),
      makeSegment('mem', 'memory data', 'memory'),
    ];
    const result = applyCachePolicy(segments);
    expect(result[0].locked).toBe(true);
    expect(result[1].locked).toBe(false);
  });

  it('locks tools segments by default', () => {
    const segments = [
      makeSegment('tools', 'tool schemas...', 'tools'),
      makeSegment('hist', 'conversation', 'history'),
    ];
    const result = applyCachePolicy(segments);
    expect(result[0].locked).toBe(true);
    expect(result[1].locked).toBe(false);
  });

  it('locks first N segments when configured', () => {
    const segments = [
      makeSegment('a', 'first', 'memory'),
      makeSegment('b', 'second', 'memory'),
      makeSegment('c', 'third', 'memory'),
    ];
    const result = applyCachePolicy(segments, { lockFirstN: 2, lockSystem: false, lockTools: false });
    expect(result[0].locked).toBe(true);
    expect(result[1].locked).toBe(true);
    expect(result[2].locked).toBe(false);
  });

  it('supports custom predicate', () => {
    const segments = [
      makeSegment('a', 'important', 'custom'),
      makeSegment('b', 'not important', 'custom'),
    ];
    const result = applyCachePolicy(segments, {
      lockSystem: false,
      lockTools: false,
      lockPredicate: (s) => s.content.includes('important') && !s.content.includes('not'),
    });
    expect(result[0].locked).toBe(true);
    expect(result[1].locked).toBe(false);
  });

  it('preserves existing locks', () => {
    const segments = [
      makeSegment('a', 'already locked', 'memory', true),
    ];
    const result = applyCachePolicy(segments, { lockSystem: false, lockTools: false });
    expect(result[0].locked).toBe(true);
  });

  it('does not mutate original segments', () => {
    const segments = [makeSegment('sys', 'system', 'system')];
    const result = applyCachePolicy(segments);
    expect(result[0]).not.toBe(segments[0]); // different object
    expect(segments[0].locked).toBe(false); // original unchanged
  });

  it('can disable system and tools locking', () => {
    const segments = [
      makeSegment('sys', 'system', 'system'),
      makeSegment('tools', 'tools', 'tools'),
    ];
    const result = applyCachePolicy(segments, { lockSystem: false, lockTools: false });
    expect(result[0].locked).toBe(false);
    expect(result[1].locked).toBe(false);
  });
});

describe('computePrefixHashes', () => {
  it('computes hashes for locked segments only', () => {
    const segments = [
      makeSegment('sys', 'system prompt', 'system', true),
      makeSegment('mem', 'memory data', 'memory', false),
    ];
    const hashes = computePrefixHashes(segments);
    expect(hashes.size).toBe(1);
  });

  it('returns empty set when no segments are locked', () => {
    const segments = [makeSegment('mem', 'data', 'memory')];
    const hashes = computePrefixHashes(segments);
    expect(hashes.size).toBe(0);
  });
});

describe('measureCacheHitRate', () => {
  it('returns 1.0 for identical hashes', () => {
    const hashes = new Set([123, 456]);
    expect(measureCacheHitRate(hashes, hashes)).toBe(1.0);
  });

  it('returns 0.0 for completely different hashes', () => {
    const current = new Set([789]);
    const previous = new Set([123]);
    expect(measureCacheHitRate(current, previous)).toBe(0.0);
  });

  it('returns partial rate for partial overlap', () => {
    const current = new Set([123, 789]);
    const previous = new Set([123, 456]);
    expect(measureCacheHitRate(current, previous)).toBe(0.5);
  });

  it('returns 1.0 when previous is empty', () => {
    expect(measureCacheHitRate(new Set([123]), new Set())).toBe(1.0);
  });
});
