import { describe, it, expect } from 'vitest';
import { formatCommunities, createCommunityFormatterStage } from '../src/memory/graph/community-formatter.js';
import { COMMUNITIES } from './fixtures/memory-hierarchy.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

describe('formatCommunities', () => {
  it('formats communities with labels and summaries', () => {
    const result = formatCommunities(COMMUNITIES);
    expect(result).toContain('Communities:');
    expect(result).toContain('Platform Engineering Team');
    expect(result).toContain('API Architecture');
  });

  it('shows entity count and level', () => {
    const result = formatCommunities(COMMUNITIES);
    expect(result).toContain('level 1, 4 entities');
    expect(result).toContain('level 2, 2 entities');
  });

  it('sorts by relevance (weight) by default', () => {
    const result = formatCommunities(COMMUNITIES);
    const teamIdx = result.indexOf('Platform Engineering Team');
    const apiIdx = result.indexOf('API Architecture');
    expect(teamIdx).toBeLessThan(apiIdx); // weight 0.95 > 0.75
  });

  it('respects maxLevel filter', () => {
    const result = formatCommunities(COMMUNITIES, { maxLevel: 1 });
    expect(result).toContain('Platform Engineering Team');
    expect(result).not.toContain('API Architecture'); // level 2, filtered
  });

  it('truncates long summaries', () => {
    const result = formatCommunities(COMMUNITIES, { maxSummaryLength: 30 });
    expect(result).toContain('...');
  });

  it('returns empty string for empty input', () => {
    expect(formatCommunities([])).toBe('');
  });
});

describe('createCommunityFormatterStage', () => {
  it('formats segments with contentType community', () => {
    const stage = createCommunityFormatterStage();
    const content = JSON.stringify(COMMUNITIES);
    const segments: PromptSegment[] = [{
      id: 'c', content, role: 'memory', priority: 1, locked: false,
      metadata: { contentType: 'community' },
    }];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toContain('Communities:');
  });

  it('has name community-formatter', () => {
    expect(createCommunityFormatterStage().name).toBe('community-formatter');
  });
});
