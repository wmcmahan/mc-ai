import { describe, it, expect } from 'vitest';
import { createPipeline } from '@mcai/context-engine';
import type { BudgetConfig } from '@mcai/context-engine';
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  MemoryConsolidator,
  ConflictDetector,
} from '@mcai/memory';

const defaultBudget: BudgetConfig = {
  maxTokens: 4096,
  outputReserve: 0,
};

describe('empty-state edge cases', () => {
  it('empty memory store retrieval returns empty result', async () => {
    const store = new InMemoryMemoryStore();

    const entities = await store.findEntities();
    const facts = await store.findFacts();
    const episodes = await store.listEpisodes();
    const themes = await store.listThemes();

    expect(entities).toEqual([]);
    expect(facts).toEqual([]);
    expect(episodes).toEqual([]);
    expect(themes).toEqual([]);
  });

  it('empty pipeline (no stages) passes segments through', () => {
    const pipeline = createPipeline({ stages: [] });
    const segment = {
      id: 'test',
      content: 'Hello world',
      role: 'memory' as const,
      priority: 1,
      locked: false,
    };

    const result = pipeline.compress({
      segments: [segment],
      budget: defaultBudget,
    });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].content).toBe('Hello world');
  });

  it('pipeline with empty segments list returns empty', () => {
    const pipeline = createPipeline({ stages: [] });

    const result = pipeline.compress({
      segments: [],
      budget: defaultBudget,
    });

    expect(result.segments).toHaveLength(0);
    expect(result.metrics.totalTokensIn).toBe(0);
  });

  it('memory index search with no data returns empty', async () => {
    const index = new InMemoryMemoryIndex();

    const entityResults = await index.searchEntities([0.1, 0.2, 0.3]);
    const factResults = await index.searchFacts([0.1, 0.2, 0.3]);

    expect(entityResults).toEqual([]);
    expect(factResults).toEqual([]);
  });

  it('consolidator on empty store returns report with zeros', async () => {
    const store = new InMemoryMemoryStore();
    const index = new InMemoryMemoryIndex();
    const consolidator = new MemoryConsolidator(store, index);

    const report = await consolidator.consolidate();

    expect(report.factsDeduped).toBe(0);
    expect(report.factsDecayed).toBe(0);
    expect(report.episodesPruned).toBe(0);
    expect(report.totalReclaimed).toBe(0);
  });

  it('conflict detector on empty store finds no conflicts', async () => {
    const store = new InMemoryMemoryStore();
    const index = new InMemoryMemoryIndex();
    const detector = new ConflictDetector(store, index);

    const conflicts = await detector.detectConflicts();

    expect(conflicts).toEqual([]);
  });
});
