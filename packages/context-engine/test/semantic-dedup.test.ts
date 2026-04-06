import { describe, it, expect } from 'vitest';
import { createSemanticDedupStage, precomputeEmbeddings } from '../src/memory/dedup/semantic.js';
import type { EmbeddingProvider } from '../src/providers/types.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';
import { fnv1a } from '../src/memory/dedup/exact.js';

const counter = new DefaultTokenCounter();

// Mock embedding provider: deterministic pseudo-embeddings from content hash
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => {
      const hash = fnv1a(t);
      return Array.from({ length: 8 }, (_, i) => Math.sin(hash * (i + 1)));
    });
  }
}

// Provider that returns identical vectors for similar-meaning texts
class SimilarityMockProvider implements EmbeddingProvider {
  readonly dimensions = 4;
  private similarGroups: string[][];

  constructor(similarGroups: string[][]) {
    this.similarGroups = similarGroups;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => {
      // Find which group this text belongs to
      for (let gi = 0; gi < this.similarGroups.length; gi++) {
        if (this.similarGroups[gi].some(s => text.includes(s))) {
          // Same group → similar vector (small perturbation)
          const base = [gi + 1, gi + 2, gi + 3, gi + 4];
          const perturbation = text.length * 0.001;
          return base.map(v => v + perturbation);
        }
      }
      // No group → random-ish vector
      const hash = fnv1a(text);
      return [Math.sin(hash), Math.cos(hash), Math.sin(hash * 2), Math.cos(hash * 2)];
    });
  }
}

function makeSegment(id: string, content: string): PromptSegment {
  return { id, content, role: 'memory', priority: 1, locked: false };
}

describe('precomputeEmbeddings', () => {
  it('embeds all unique paragraphs from segments', async () => {
    const provider = new MockEmbeddingProvider();
    const segments = [
      makeSegment('a', 'First paragraph of sufficient length.\n\nSecond paragraph of sufficient length.'),
      makeSegment('b', 'Third paragraph of sufficient length.'),
    ];

    const map = await precomputeEmbeddings(segments, provider);
    expect(map.size).toBe(3);
    expect(map.get('First paragraph of sufficient length.')).toBeDefined();
    expect(map.get('First paragraph of sufficient length.')!.length).toBe(8);
  });

  it('deduplicates identical paragraphs before embedding', async () => {
    const provider = new MockEmbeddingProvider();
    const segments = [
      makeSegment('a', 'Same paragraph repeated here.'),
      makeSegment('b', 'Same paragraph repeated here.'),
    ];

    const map = await precomputeEmbeddings(segments, provider);
    expect(map.size).toBe(1); // Only embedded once
  });

  it('skips short paragraphs', async () => {
    const provider = new MockEmbeddingProvider();
    const segments = [makeSegment('a', 'short\n\nThis is a longer paragraph that meets the minimum length.')];

    const map = await precomputeEmbeddings(segments, provider);
    expect(map.has('short')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('returns empty map for empty segments', async () => {
    const provider = new MockEmbeddingProvider();
    const map = await precomputeEmbeddings([], provider);
    expect(map.size).toBe(0);
  });
});

describe('createSemanticDedupStage', () => {
  it('removes semantically similar paragraphs', async () => {
    // Two paragraphs that mean the same thing
    const similar1 = 'Multi-agent systems are significantly more expensive than single-agent setups in production';
    const similar2 = 'Multi-agent systems are significantly more costly than single-agent setups in production';
    const unique = 'Local deployment improves data sovereignty and reduces latency for enterprises.';

    const provider = new SimilarityMockProvider([
      ['Multi-agent systems are significantly more'], // group 0: similar meaning
    ]);

    const segments = [makeSegment('a', `${similar1}\n\n${unique}\n\n${similar2}`)];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({
      provider,
      precomputed,
      threshold: 0.99, // High threshold — our mock makes very similar vectors for the group
    });

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    const output = result.segments[0].content;

    // Should keep the unique paragraph
    expect(output).toContain('sovereignty');
    // Should have removed one of the similar paragraphs
    const inputTokens = counter.countTokens(segments[0].content);
    const outputTokens = counter.countTokens(output);
    expect(outputTokens).toBeLessThan(inputTokens);
  });

  it('passes through when no pre-computed embeddings', () => {
    const provider = new MockEmbeddingProvider();
    const stage = createSemanticDedupStage({ provider });

    const segments = [makeSegment('a', 'content here')];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe('content here');
  });

  it('keeps longer paragraph of a duplicate pair', async () => {
    const shorter = 'Agents are expensive to run in production environments.';
    const longer = 'Agents are expensive to run in production environments and require careful optimization strategies.';

    const provider = new SimilarityMockProvider([['Agents are expensive']]);
    const segments = [makeSegment('a', `${shorter}\n\n${longer}`)];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({
      provider,
      precomputed,
      threshold: 0.99,
    });

    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toContain('optimization strategies');
  });

  it('has name semantic-dedup', () => {
    const provider = new MockEmbeddingProvider();
    expect(createSemanticDedupStage({ provider }).name).toBe('semantic-dedup');
  });

  it('handles segments with all short paragraphs', async () => {
    const provider = new MockEmbeddingProvider();
    const segments = [makeSegment('a', 'short\ntext\nhere')];
    const precomputed = await precomputeEmbeddings(segments, provider);

    const stage = createSemanticDedupStage({ provider, precomputed });
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe('short\ntext\nhere');
  });
});
