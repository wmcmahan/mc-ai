import { describe, it, expect } from 'vitest';
import { createTokenCounter, countSegmentTokens, countTotalTokens } from '../src/budget/counter.js';
import type { PromptSegment } from '../src/pipeline/types.js';
import type { TokenCounter } from '../src/providers/types.js';

function makeSegment(id: string, content: string): PromptSegment {
  return { id, content, role: 'memory', priority: 1, locked: false };
}

describe('createTokenCounter', () => {
  it('returns default counter when no provider given', () => {
    const counter = createTokenCounter();
    expect(counter.countTokens('hello')).toBeGreaterThan(0);
  });

  it('wraps custom provider', () => {
    const custom: TokenCounter = { countTokens: () => 42 };
    const counter = createTokenCounter(custom);
    expect(counter.countTokens('anything')).toBe(42);
  });
});

describe('countSegmentTokens', () => {
  it('returns token count per segment', () => {
    const counter = createTokenCounter();
    const segments = [
      makeSegment('a', 'hello world'),
      makeSegment('b', 'foo bar baz'),
    ];
    const counts = countSegmentTokens(segments, counter);
    expect(counts.get('a')).toBeGreaterThan(0);
    expect(counts.get('b')).toBeGreaterThan(0);
  });

  it('uses model for counting when provided', () => {
    const counter = createTokenCounter();
    const segments = [makeSegment('a', 'a'.repeat(100))];
    const withModel = countSegmentTokens(segments, counter, 'claude-sonnet-4');
    const withoutModel = countSegmentTokens(segments, counter);
    // Different ratios should give different counts
    expect(withModel.get('a')).not.toBe(withoutModel.get('a'));
  });
});

describe('countTotalTokens', () => {
  it('sums tokens across all segments', () => {
    const counter = createTokenCounter();
    const segments = [
      makeSegment('a', 'hello'),
      makeSegment('b', 'world'),
    ];
    const total = countTotalTokens(segments, counter);
    const individual = countSegmentTokens(segments, counter);
    expect(total).toBe((individual.get('a') ?? 0) + (individual.get('b') ?? 0));
  });

  it('returns 0 for empty segments', () => {
    const counter = createTokenCounter();
    expect(countTotalTokens([], counter)).toBe(0);
  });
});
