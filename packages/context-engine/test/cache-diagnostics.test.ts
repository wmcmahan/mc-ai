import { describe, it, expect } from 'vitest';
import { diagnoseCacheStability } from '../src/budget/cache-diagnostics.js';
import { computeSegmentHashMap } from '../src/budget/cache-policy.js';
import type { PromptSegment } from '../src/pipeline/types.js';

function makeSegment(id: string, content: string, role: PromptSegment['role'] = 'memory'): PromptSegment {
  return { id, content, role, priority: 1, locked: false };
}

describe('diagnoseCacheStability', () => {
  it('returns hitRate 1.0 when all segments are stable', () => {
    const segments = [
      makeSegment('a', 'hello world'),
      makeSegment('b', 'foo bar'),
    ];
    const previous = computeSegmentHashMap(segments);

    const diag = diagnoseCacheStability(segments, previous);
    expect(diag.hitRate).toBe(1.0);
    expect(diag.unstableSegments).toHaveLength(0);
    expect(diag.recommendations).toHaveLength(0);
  });

  it('detects one mutated segment', () => {
    const original = [
      makeSegment('a', 'hello world'),
      makeSegment('b', 'foo bar'),
    ];
    const previous = computeSegmentHashMap(original);

    const current = [
      makeSegment('a', 'hello world'),
      makeSegment('b', 'foo bar changed'),
    ];

    const diag = diagnoseCacheStability(current, previous);
    expect(diag.hitRate).toBe(0.5); // 1 of 2 stable
    expect(diag.unstableSegments).toHaveLength(1);
    expect(diag.unstableSegments[0].id).toBe('b');
  });

  it('returns hitRate 1.0 when previousHashes is empty (first turn)', () => {
    const segments = [
      makeSegment('a', 'hello'),
      makeSegment('b', 'world'),
    ];

    const diag = diagnoseCacheStability(segments, new Map());
    expect(diag.hitRate).toBe(1.0);
    expect(diag.unstableSegments).toHaveLength(0);
  });

  it('new segments do not affect hitRate', () => {
    const original = [makeSegment('a', 'hello')];
    const previous = computeSegmentHashMap(original);

    // Add a new segment
    const current = [
      makeSegment('a', 'hello'),
      makeSegment('b', 'new segment'),
    ];

    const diag = diagnoseCacheStability(current, previous);
    expect(diag.hitRate).toBe(1.0); // only 'a' is comparable, and it's stable
    expect(diag.unstableSegments).toHaveLength(0);
  });

  it('removed segments do not affect hitRate', () => {
    const original = [
      makeSegment('a', 'hello'),
      makeSegment('b', 'world'),
    ];
    const previous = computeSegmentHashMap(original);

    // Only 'a' remains
    const current = [makeSegment('a', 'hello')];

    const diag = diagnoseCacheStability(current, previous);
    expect(diag.hitRate).toBe(1.0); // only 'a' is comparable
    expect(diag.unstableSegments).toHaveLength(0);
  });

  it('recommendations include segment ID and role', () => {
    const original = [makeSegment('sys-prompt', 'original content', 'system')];
    const previous = computeSegmentHashMap(original);

    const current = [makeSegment('sys-prompt', 'modified content', 'system')];

    const diag = diagnoseCacheStability(current, previous);
    expect(diag.recommendations).toHaveLength(1);
    expect(diag.recommendations[0]).toContain('sys-prompt');
    expect(diag.recommendations[0]).toContain('system');
  });

  it('handles all segments mutated', () => {
    const original = [
      makeSegment('a', 'hello'),
      makeSegment('b', 'world'),
    ];
    const previous = computeSegmentHashMap(original);

    const current = [
      makeSegment('a', 'changed-a'),
      makeSegment('b', 'changed-b'),
    ];

    const diag = diagnoseCacheStability(current, previous);
    expect(diag.hitRate).toBe(0);
    expect(diag.unstableSegments).toHaveLength(2);
    expect(diag.recommendations).toHaveLength(2);
  });

  it('unstable segment hashes are correct', () => {
    const original = [makeSegment('a', 'hello')];
    const previous = computeSegmentHashMap(original);
    const previousHash = previous.get('a')!;

    const current = [makeSegment('a', 'goodbye')];
    const currentHash = computeSegmentHashMap(current).get('a')!;

    const diag = diagnoseCacheStability(current, previous);
    expect(diag.unstableSegments[0].hashPrevious).toBe(previousHash);
    expect(diag.unstableSegments[0].hashCurrent).toBe(currentHash);
    expect(diag.unstableSegments[0].hashPrevious).not.toBe(diag.unstableSegments[0].hashCurrent);
  });

  it('mix of new, stable, unstable, and removed segments', () => {
    const original = [
      makeSegment('stable', 'same'),
      makeSegment('changed', 'before'),
      makeSegment('removed', 'gone'),
    ];
    const previous = computeSegmentHashMap(original);

    const current = [
      makeSegment('stable', 'same'),
      makeSegment('changed', 'after'),
      makeSegment('new', 'fresh'),
    ];

    const diag = diagnoseCacheStability(current, previous);
    // comparable: stable + changed = 2; stable = 1
    expect(diag.hitRate).toBe(0.5);
    expect(diag.unstableSegments).toHaveLength(1);
    expect(diag.unstableSegments[0].id).toBe('changed');
  });
});

describe('computeSegmentHashMap', () => {
  it('returns correct mapping', () => {
    const segments = [
      makeSegment('a', 'hello'),
      makeSegment('b', 'world'),
    ];

    const map = computeSegmentHashMap(segments);
    expect(map.size).toBe(2);
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(true);
    expect(typeof map.get('a')).toBe('number');
  });

  it('same content produces same hash', () => {
    const seg1 = [makeSegment('x', 'identical')];
    const seg2 = [makeSegment('x', 'identical')];

    const map1 = computeSegmentHashMap(seg1);
    const map2 = computeSegmentHashMap(seg2);
    expect(map1.get('x')).toBe(map2.get('x'));
  });

  it('different content produces different hash', () => {
    const seg1 = [makeSegment('x', 'hello')];
    const seg2 = [makeSegment('x', 'world')];

    const map1 = computeSegmentHashMap(seg1);
    const map2 = computeSegmentHashMap(seg2);
    expect(map1.get('x')).not.toBe(map2.get('x'));
  });
});
