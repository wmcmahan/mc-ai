import { describe, it, expect, vi } from 'vitest';
import { trigramSet, jaccardSimilarity, fuzzyDedup, createFuzzyDedupStage } from '../src/memory/dedup/fuzzy.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

describe('trigramSet', () => {
  it('generates correct trigrams', () => {
    const trigrams = trigramSet('hello');
    expect(trigrams.has('hel')).toBe(true);
    expect(trigrams.has('ell')).toBe(true);
    expect(trigrams.has('llo')).toBe(true);
    expect(trigrams.size).toBe(3);
  });

  it('is case-insensitive', () => {
    const a = trigramSet('Hello');
    const b = trigramSet('hello');
    expect(a).toEqual(b);
  });

  it('returns empty set for strings shorter than 3', () => {
    expect(trigramSet('ab').size).toBe(0);
    expect(trigramSet('').size).toBe(0);
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical sets', () => {
    const a = trigramSet('hello world');
    expect(jaccardSimilarity(a, a)).toBe(1.0);
  });

  it('returns 0.0 for disjoint sets', () => {
    const a = new Set(['abc', 'def']);
    const b = new Set(['xyz', 'uvw']);
    expect(jaccardSimilarity(a, b)).toBe(0.0);
  });

  it('returns value between 0 and 1 for partial overlap', () => {
    const a = trigramSet('hello world');
    const b = trigramSet('hello earth');
    const sim = jaccardSimilarity(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('handles empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1.0);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0.0);
  });
});

describe('fuzzyDedup', () => {
  it('detects near-duplicates differing by one word', () => {
    const items = [
      'Multi-agent systems cost 5-10x more than single-agent setups in production environments today',
      'Multi-agent systems cost 5-10x more than single-agent setups in production environments now',
    ];
    const result = fuzzyDedup(items, { threshold: 0.8 });
    expect(result.removed).toBe(1);
    expect(result.unique).toHaveLength(1);
  });

  it('keeps both when items are sufficiently different', () => {
    const items = [
      'Multi-agent systems are expensive to operate',
      'Local deployment improves data sovereignty and compliance',
    ];
    const result = fuzzyDedup(items);
    expect(result.removed).toBe(0);
    expect(result.unique).toHaveLength(2);
  });

  it('keeps shorter of duplicates', () => {
    const shorter = 'Agents cost 5-10x more than single-agent setups in production';
    const longer = 'Agents cost 5-10x more than single-agent setups in production environments and deployments';
    const result = fuzzyDedup([longer, shorter], { threshold: 0.7 });
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0]).toBe(shorter);
  });

  it('skips items shorter than minLength', () => {
    const items = ['hi', 'hello'];
    const result = fuzzyDedup(items, { minLength: 20 });
    expect(result.removed).toBe(0);
    expect(result.unique).toHaveLength(2);
  });

  it('respects configurable threshold', () => {
    const items = [
      'The quick brown fox jumps over the lazy dog in the park',
      'The quick brown fox jumps over the lazy cat in the park',
    ];
    // Low threshold — should match
    const loose = fuzzyDedup(items, { threshold: 0.5 });
    expect(loose.removed).toBe(1);

    // High threshold — might not match
    const strict = fuzzyDedup(items, { threshold: 0.99 });
    expect(strict.removed).toBe(0);
  });

  it('handles empty input', () => {
    const result = fuzzyDedup([]);
    expect(result.unique).toEqual([]);
    expect(result.removed).toBe(0);
  });

  it('handles single item', () => {
    const result = fuzzyDedup(['only one item here for testing']);
    expect(result.unique).toHaveLength(1);
    expect(result.removed).toBe(0);
  });

  it('produces order-independent results', () => {
    const base = 'Multi-agent systems cost 5-10x more than single-agent setups in production environments';
    const a = base + ' today and tomorrow';
    const b = base + ' now and forever';
    const c = base + ' currently and always';

    const order1 = fuzzyDedup([a, b, c], { threshold: 0.8 });
    const order2 = fuzzyDedup([c, b, a], { threshold: 0.8 });
    const order3 = fuzzyDedup([b, a, c], { threshold: 0.8 });

    // Same items should survive regardless of input order
    const kept1 = new Set(order1.unique);
    const kept2 = new Set(order2.unique);
    const kept3 = new Set(order3.unique);
    expect(kept1).toEqual(kept2);
    expect(kept2).toEqual(kept3);
  });

  it('keeps the shortest item from a cluster of similar items', () => {
    const short = 'Multi-agent systems cost 5-10x more in production';
    const medium = 'Multi-agent systems cost 5-10x more in production environments today';
    const long = 'Multi-agent systems cost 5-10x more in production environments today and tomorrow morning';

    const result = fuzzyDedup([long, medium, short], { threshold: 0.7 });
    expect(result.unique).toHaveLength(1);
    expect(result.unique[0]).toBe(short);
  });

  it('caps pairwise comparison at maxItems and passes remaining items through', () => {
    const base = 'Multi-agent systems cost 5-10x more than single-agent setups in production environments';
    // Items 0-2 are similar (within cap of 3), items 3-4 are beyond cap
    const items = [
      base + ' today',
      base + ' now',
      base + ' currently',
      base + ' forever',
      'Completely different content about local deployment and data sovereignty compliance requirements',
    ];
    const result = fuzzyDedup(items, { threshold: 0.8, maxItems: 3 });
    // First 3 items should be deduped (similar), items 3 and 4 pass through undeduped
    expect(result.unique).toContain(items[3]);
    expect(result.unique).toContain(items[4]);
    // At least some of the first 3 should be deduped
    expect(result.removed).toBeGreaterThan(0);
  });

  it('logs a warning when items exceed maxItems', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = [
      'First item is long enough for comparison here and there',
      'Second item is long enough for comparison here and now',
      'Third item is long enough for comparison here and today',
      'Fourth item is long enough for comparison here and currently',
      'Fifth item is long enough for comparison here and forever',
    ];
    fuzzyDedup(items, { maxItems: 3 });
    expect(warnSpy).toHaveBeenCalledWith('context-engine: fuzzy dedup capped at 3 items (5 provided)');
    warnSpy.mockRestore();
  });

  it('does not warn when items are within default maxItems of 500', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = Array.from({ length: 10 }, (_, i) => `Unique item number ${i} with sufficient length for comparison`);
    fuzzyDedup(items);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('createFuzzyDedupStage', () => {
  function makeSegment(id: string, content: string): PromptSegment {
    return { id, content, role: 'memory', priority: 1, locked: false };
  }

  it('removes near-duplicate paragraphs across segments', () => {
    const stage = createFuzzyDedupStage({ threshold: 0.8 });
    const shared = 'Multi-agent systems cost 5-10x more than single-agent setups in production environments today';
    const seg1 = makeSegment('a', `${shared}\n\nContext compression reduces token costs by 40-60% on average.`);
    const seg2 = makeSegment('b', `${shared.replace('today', 'now')}\n\nLocal deployment improves data sovereignty and compliance requirements.`);

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute([seg1, seg2], context);
    const totalContent = result.segments.map(s => s.content).join(' ');

    // The near-duplicate first paragraph should be removed from one segment
    expect(totalContent).toContain('token costs');
    expect(totalContent).toContain('sovereignty');
    // Total content should be shorter than input
    const inputLength = seg1.content.length + seg2.content.length;
    const outputLength = result.segments[0].content.length + result.segments[1].content.length;
    expect(outputLength).toBeLessThan(inputLength);
  });

  it('handles single-segment single-paragraph content unchanged', () => {
    const stage = createFuzzyDedupStage();
    const seg = makeSegment('a', 'Just a single paragraph of unique content that should pass through unchanged.');
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };
    const result = stage.execute([seg], context);
    expect(result.segments[0].content).toBe(seg.content);
  });

  it('has name fuzzy-dedup', () => {
    const stage = createFuzzyDedupStage();
    expect(stage.name).toBe('fuzzy-dedup');
  });
});
