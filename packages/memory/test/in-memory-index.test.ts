import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore, InMemoryMemoryIndex } from '../src/index.js';
import type { Entity, SemanticFact, Theme, Provenance } from '../src/index.js';

const now = new Date();
const prov: Provenance = { source: 'system', created_at: now };

function makeEntity(embedding: number[]): Entity {
  return {
    id: crypto.randomUUID(),
    name: 'Test',
    entity_type: 'concept',
    attributes: {},
    embedding,
    provenance: prov,
    created_at: now,
    updated_at: now,
  };
}

function makeFact(embedding: number[]): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content: 'Fact',
    source_episode_ids: [],
    entity_ids: [],
    embedding,
    provenance: prov,
    valid_from: now,
  };
}

function makeTheme(embedding: number[]): Theme {
  return {
    id: crypto.randomUUID(),
    label: 'Theme',
    description: '',
    fact_ids: [],
    embedding,
    provenance: prov,
  };
}

describe('InMemoryMemoryIndex', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  it('finds similar entities by embedding', async () => {
    const e1 = makeEntity([1, 0, 0]);
    const e2 = makeEntity([0, 1, 0]);
    const e3 = makeEntity([0.9, 0.1, 0]);

    await store.putEntity(e1);
    await store.putEntity(e2);
    await store.putEntity(e3);
    await index.rebuild(store);

    const results = await index.searchEntities([1, 0, 0], { min_similarity: 0.8 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].item.id).toBe(e1.id);
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it('respects min_similarity threshold', async () => {
    await store.putEntity(makeEntity([0, 1, 0]));
    await index.rebuild(store);

    const results = await index.searchEntities([1, 0, 0], { min_similarity: 0.9 });
    expect(results).toHaveLength(0);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.putEntity(makeEntity([1, 0, i * 0.01]));
    }
    await index.rebuild(store);

    const results = await index.searchEntities([1, 0, 0], { limit: 2, min_similarity: 0.5 });
    expect(results).toHaveLength(2);
  });

  it('searches facts by embedding', async () => {
    await store.putFact(makeFact([1, 0, 0]));
    await store.putFact(makeFact([0, 1, 0]));
    await index.rebuild(store);

    const results = await index.searchFacts([1, 0, 0], { min_similarity: 0.9 });
    expect(results).toHaveLength(1);
  });

  it('searches themes by embedding', async () => {
    await store.putTheme(makeTheme([1, 0, 0]));
    await index.rebuild(store);

    const results = await index.searchThemes([1, 0, 0], { min_similarity: 0.9 });
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it('skips records without embeddings', async () => {
    const entityNoEmbed: Entity = {
      id: crypto.randomUUID(),
      name: 'No embed',
      entity_type: 'concept',
      attributes: {},
      provenance: prov,
      created_at: now,
      updated_at: now,
    };
    await store.putEntity(entityNoEmbed);
    await index.rebuild(store);

    const results = await index.searchEntities([1, 0, 0], { min_similarity: 0 });
    expect(results).toHaveLength(0);
  });
});
