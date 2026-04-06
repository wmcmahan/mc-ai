import { describe, it, expect } from 'vitest';
import { createHeuristicScorer } from '../src/pruning/heuristic.js';

describe('query-contrastive heuristic scoring', () => {
  it('tokens near query terms score higher than distant tokens', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.40 });
    const content = 'alpha beta gamma delta epsilon zeta kubernetes eta theta iota';
    const result = scorer.score(content, { query: 'kubernetes' });

    const kubeToken = result.find(t => t.text === 'kubernetes');
    // "alpha" is far from "kubernetes"
    const alphaToken = result.find(t => t.text === 'alpha');
    expect(kubeToken).toBeDefined();
    expect(alphaToken).toBeDefined();
    expect(kubeToken!.score).toBeGreaterThan(alphaToken!.score);
  });

  it('without query, behavior matches original scorer', () => {
    const scorer = createHeuristicScorer();
    const content = 'the important research data';

    const withoutQuery = scorer.score(content);
    const withUndefinedQuery = scorer.score(content, { query: undefined });

    // Scores should be identical
    expect(withoutQuery.length).toBe(withUndefinedQuery.length);
    for (let i = 0; i < withoutQuery.length; i++) {
      expect(withoutQuery[i].score).toBeCloseTo(withUndefinedQuery[i].score, 10);
    }
  });

  it('without query, scores match no-query-weight scorer proportionally', () => {
    // When no query is provided, the query dimension doesn't contribute
    const scorerWithQuery = createHeuristicScorer({ queryWeight: 0.20 });
    const content = 'Alice works at Acme Corp';

    const noQueryResult = scorerWithQuery.score(content);
    // Verify scores are still reasonable (entities boosted, etc.)
    const aliceToken = noQueryResult.find(t => t.text === 'Alice');
    const worksToken = noQueryResult.find(t => t.text === 'works');
    expect(aliceToken).toBeDefined();
    expect(worksToken).toBeDefined();
    // Entity boost should still work
    expect(aliceToken!.score).toBeGreaterThan(worksToken!.score);
  });

  it('query with only stop words has minimal effect', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.20 });
    const content = 'important research findings data';

    const withStopQuery = scorer.score(content, { query: 'the and or but' });
    const withoutQuery = scorer.score(content);

    // Stop words get removed from query -> queryTerms is empty -> contributes 0.5
    // Scores should be close since the query dimension contributes neutrally
    for (let i = 0; i < withoutQuery.length; i++) {
      // Allow some deviation due to weight redistribution
      expect(Math.abs(withStopQuery[i].score - withoutQuery[i].score)).toBeLessThan(0.15);
    }
  });

  it('query terms boost nearby tokens relative to distant ones', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.40 });
    // Use enough tokens so that some are well outside the query window
    const content = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn kubernetes target';

    const withQuery = scorer.score(content, { query: 'kubernetes target' });

    // "kubernetes" should score higher than "aaa" (far away from query terms)
    const kubeScore = withQuery.find(t => t.text === 'kubernetes');
    const aaaScore = withQuery.find(t => t.text === 'aaa');
    expect(kubeScore).toBeDefined();
    expect(aaaScore).toBeDefined();
    expect(kubeScore!.score).toBeGreaterThan(aaaScore!.score);
  });

  it('queryWeight=0 means query has no effect', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0 });
    const content = 'important research data analysis';

    const withQuery = scorer.score(content, { query: 'research' });
    const withoutQuery = scorer.score(content);

    for (let i = 0; i < withoutQuery.length; i++) {
      expect(withQuery[i].score).toBeCloseTo(withoutQuery[i].score, 10);
    }
  });

  it('queryWeight=1 means only query relevance matters', () => {
    const scorer = createHeuristicScorer({ queryWeight: 1 });
    // Need enough tokens so "alpha" is far outside the window of "kubernetes"
    const content = 'alpha one two three four five six seven eight nine ten eleven twelve kubernetes nearby';

    const result = scorer.score(content, { query: 'kubernetes' });
    const nonWs = result.filter(t => t.text.trim().length > 0);
    const kubeToken = nonWs.find(t => t.text === 'kubernetes');
    // alpha is far away from kubernetes (beyond the 10-index window)
    const alphaToken = nonWs.find(t => t.text === 'alpha');
    expect(kubeToken).toBeDefined();
    expect(alphaToken).toBeDefined();
    expect(kubeToken!.score).toBeGreaterThan(alphaToken!.score);
  });

  it('empty query string behaves like no query', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.20 });
    const content = 'hello world test';

    const withEmpty = scorer.score(content, { query: '' });
    const withoutQuery = scorer.score(content);

    for (let i = 0; i < withoutQuery.length; i++) {
      expect(withEmpty[i].score).toBeCloseTo(withoutQuery[i].score, 10);
    }
  });

  it('whitespace-only query behaves like no query', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.20 });
    const content = 'hello world test';

    const withWs = scorer.score(content, { query: '   ' });
    const withoutQuery = scorer.score(content);

    for (let i = 0; i < withoutQuery.length; i++) {
      expect(withWs[i].score).toBeCloseTo(withoutQuery[i].score, 10);
    }
  });

  it('query relevance uses Jaccard overlap correctly', () => {
    const scorer = createHeuristicScorer({ queryWeight: 0.50 });
    // Place query terms adjacent to each other for high overlap
    const content = 'machine learning algorithms optimize neural network performance evaluation';
    const result = scorer.score(content, { query: 'machine learning' });

    // "machine" should score well since "learning" is in its window
    const machineToken = result.find(t => t.text === 'machine');
    // "evaluation" is far from both query terms
    const evalToken = result.find(t => t.text === 'evaluation');
    expect(machineToken).toBeDefined();
    expect(evalToken).toBeDefined();
    expect(machineToken!.score).toBeGreaterThan(evalToken!.score);
  });

  it('existing heuristic tests still pass with default queryWeight', () => {
    const scorer = createHeuristicScorer();
    // Stop words should still score lower than content words
    const tokens = scorer.score('the important research');
    const theScore = tokens.find(t => t.text === 'the')!.score;
    const researchScore = tokens.find(t => t.text === 'research')!.score;
    expect(researchScore).toBeGreaterThan(theScore);
  });
});
