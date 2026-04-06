import { describe, it, expect } from 'vitest';
import {
  precomputeImportanceScores,
  createSelfInformationScorer,
  createSelfInformationStage,
} from '../src/pruning/self-information.js';
import type { CompressionProvider } from '../src/providers/types.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

function makeSegment(id: string, content: string): PromptSegment {
  return { id, content, role: 'memory', priority: 1, locked: false };
}

// Mock provider: scores based on word length (longer = more important)
class MockCompressionProvider implements CompressionProvider {
  callCount = 0;

  async scoreTokenImportance(tokens: string[], context?: string): Promise<number[]> {
    this.callCount++;
    return tokens.map(t => {
      const trimmed = t.trim();
      if (trimmed.length === 0) return 0.5;
      // Longer tokens = higher importance; query boost if context matches
      let score = Math.min(1.0, trimmed.length / 20);
      if (context && trimmed.toLowerCase().includes(context.toLowerCase().slice(0, 5))) {
        score = Math.min(1.0, score + 0.3);
      }
      return score;
    });
  }
}

describe('precomputeImportanceScores', () => {
  it('scores all segments', async () => {
    const provider = new MockCompressionProvider();
    const segments = [
      makeSegment('a', 'Short sentence. A much longer and more detailed explanation.'),
      makeSegment('b', 'Another piece of content here.'),
    ];

    const scores = await precomputeImportanceScores(segments, provider, { granularity: 'sentence' });
    expect(scores.size).toBe(2);
    expect(scores.has(segments[0].content)).toBe(true);
    expect(scores.has(segments[1].content)).toBe(true);
  });

  it('deduplicates identical segments', async () => {
    const provider = new MockCompressionProvider();
    const segments = [
      makeSegment('a', 'Same content repeated.'),
      makeSegment('b', 'Same content repeated.'),
    ];

    const scores = await precomputeImportanceScores(segments, provider);
    expect(scores.size).toBe(1);
    expect(provider.callCount).toBe(1);
  });

  it('supports token-level granularity', async () => {
    const provider = new MockCompressionProvider();
    const segments = [makeSegment('a', 'hello world foo')];

    const scores = await precomputeImportanceScores(segments, provider, { granularity: 'token' });
    const tokens = scores.get(segments[0].content)!;
    // Token split includes whitespace tokens
    expect(tokens.length).toBeGreaterThanOrEqual(3);
  });

  it('supports sentence-level granularity', async () => {
    const provider = new MockCompressionProvider();
    const segments = [makeSegment('a', 'First sentence. Second sentence. Third sentence.')];

    const scores = await precomputeImportanceScores(segments, provider, { granularity: 'sentence' });
    const tokens = scores.get(segments[0].content)!;
    expect(tokens.length).toBe(3);
  });

  it('passes query for contrastive scoring', async () => {
    const provider = new MockCompressionProvider();
    const segments = [makeSegment('a', 'cost reduction strategy. xyz.')];

    const scores = await precomputeImportanceScores(segments, provider, {
      granularity: 'sentence',
      query: 'cost',
    });
    const tokens = scores.get(segments[0].content)!;
    // "cost reduction strategy" should score higher with query="cost" boost
    // (longer + has "cost" prefix match vs. short "xyz" without)
    expect(tokens[0].score).toBeGreaterThan(tokens[1].score);
  });
});

describe('createSelfInformationScorer', () => {
  it('uses pre-computed scores when available', async () => {
    const provider = new MockCompressionProvider();
    const segments = [makeSegment('a', 'Test content here.')];
    const precomputed = await precomputeImportanceScores(segments, provider);

    const scorer = createSelfInformationScorer({ precomputed });
    const scored = scorer.score('Test content here.');

    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0].score).not.toBe(0.5); // real scores, not fallback
  });

  it('falls back to n-gram scorer for unknown content (non-uniform scores)', () => {
    // Use token granularity so each word becomes a separate scored unit
    const scorer = createSelfInformationScorer({ precomputed: new Map(), granularity: 'token' });
    const scored = scorer.score('the the the the xylophone the the the');

    // N-gram fallback should produce varied scores, not all 0.5
    const nonWs = scored.filter(t => t.text.trim().length > 0);
    const allSame = nonWs.every(t => t.score === nonWs[0].score);
    // With mixed content, scores should NOT all be the same
    expect(allSame).toBe(false);
  });

  it('handles content without sentence-ending punctuation', () => {
    const scorer = createSelfInformationScorer({ precomputed: new Map(), granularity: 'sentence' });
    const scored = scorer.score('A fragment without any period');
    // Should return the entire content as one unit
    expect(scored.length).toBe(1);
    expect(scored[0].text).toBe('A fragment without any period');
  });

  it('handles empty content', () => {
    const scorer = createSelfInformationScorer({ precomputed: new Map() });
    const scored = scorer.score('');
    expect(scored.length).toBe(0);
  });
});

describe('createSelfInformationStage', () => {
  it('reduces content when scores are pre-computed', async () => {
    const provider = new MockCompressionProvider();
    const content = 'A. Very important detailed technical explanation of the system architecture and design. B.';
    const segments = [makeSegment('a', content)];
    const precomputed = await precomputeImportanceScores(segments, provider, { granularity: 'sentence' });

    const stage = createSelfInformationStage({ precomputed });
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 10, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    const inputTokens = counter.countTokens(content);
    const outputTokens = counter.countTokens(result.segments[0].content);
    expect(outputTokens).toBeLessThanOrEqual(inputTokens);
  });

  it('passes through when no pre-computed scores and within budget', () => {
    const stage = createSelfInformationStage({});
    const content = 'short';
    const segments = [makeSegment('a', content)];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 1000, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe(content);
  });

  it('has name self-information-pruning', () => {
    const stage = createSelfInformationStage({});
    expect(stage.name).toBe('self-information-pruning');
  });
});

describe('self-information fallback scorer', () => {
  it('uses n-gram fallback when no precomputed scores exist', () => {
    // Use token granularity so each word is a separate unit
    const scorer = createSelfInformationScorer({ precomputed: new Map(), granularity: 'token' });
    const scored = scorer.score('common common common rare_xyzzy common common');

    const nonWs = scored.filter(t => t.text.trim().length > 0);
    // N-gram scorer should give varied scores for different tokens
    expect(nonWs.length).toBeGreaterThan(0);
    // rare_xyzzy should get a different score than "common"
    const rareToken = nonWs.find(t => t.text === 'rare_xyzzy');
    const commonToken = nonWs.find(t => t.text === 'common');
    expect(rareToken).toBeDefined();
    expect(commonToken).toBeDefined();
    expect(rareToken!.score).not.toBe(commonToken!.score);
  });

  it('precomputed still takes priority over fallback', async () => {
    const provider = new MockCompressionProvider();
    const content = 'Test content here.';
    const segments = [makeSegment('a', content)];
    const precomputed = await precomputeImportanceScores(segments, provider);

    const scorer = createSelfInformationScorer({ precomputed });
    const scored = scorer.score(content);

    // Should use precomputed scores, not fallback
    const precomputedScores = precomputed.get(content)!;
    expect(scored).toEqual(precomputedScores);
  });

  it('custom fallback scorer is used when provided', () => {
    const customScorer = {
      score(content: string) {
        return [{ text: content, score: 0.99, offset: 0 }];
      },
    };

    const scorer = createSelfInformationScorer({
      precomputed: new Map(),
      fallbackScorer: customScorer,
    });

    const scored = scorer.score('anything');
    expect(scored).toHaveLength(1);
    expect(scored[0].score).toBe(0.99);
  });

  it('fallback produces non-uniform scores unlike old 0.5 behavior', () => {
    // Use token granularity for multiple scored units
    const scorer = createSelfInformationScorer({ precomputed: new Map(), granularity: 'token' });
    const scored = scorer.score('The quick brown fox jumps over the lazy dog');

    const nonWs = scored.filter(t => t.text.trim().length > 0);
    // At least some scores should differ from 0.5
    const hasNonHalf = nonWs.some(t => Math.abs(t.score - 0.5) > 0.01);
    expect(hasNonHalf).toBe(true);
  });
});
