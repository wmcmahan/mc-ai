import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryMemoryStore,
  InMemoryMemoryIndex,
  retrieveMemory,
} from '../src/index.js';
import type {
  Entity,
  Relationship,
  SemanticFact,
  Theme,
  Episode,
  MemoryQuery,
  Provenance,
} from '../src/index.js';

const now = new Date();
const prov: Provenance = { source: 'system', created_at: now };

describe('retrieveMemory', () => {
  let store: InMemoryMemoryStore;
  let index: InMemoryMemoryIndex;

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    index = new InMemoryMemoryIndex();
  });

  it('returns empty result when no embedding or entity_ids', async () => {
    const result = await retrieveMemory(store, index, { max_hops: 2, limit: 20, min_similarity: 0.5, include_invalidated: false });
    expect(result.themes).toEqual([]);
    expect(result.facts).toEqual([]);
  });

  describe('embedding-based retrieval', () => {
    let theme: Theme;
    let fact: SemanticFact;
    let episode: Episode;
    let entity: Entity;

    beforeEach(async () => {
      entity = {
        id: crypto.randomUUID(),
        name: 'Alice',
        entity_type: 'person',
        attributes: {},
        provenance: prov,
        created_at: now,
        updated_at: now,
      };
      await store.putEntity(entity);

      episode = {
        id: crypto.randomUUID(),
        topic: 'Meeting',
        messages: [],
        started_at: now,
        ended_at: now,
        fact_ids: [],
        provenance: prov,
      };
      await store.putEpisode(episode);

      fact = {
        id: crypto.randomUUID(),
        content: 'Alice is a person',
        source_episode_ids: [episode.id],
        entity_ids: [entity.id],
        embedding: [1, 0, 0],
        provenance: prov,
        valid_from: now,
      };
      await store.putFact(fact);

      theme = {
        id: crypto.randomUUID(),
        label: 'People',
        description: '',
        fact_ids: [fact.id],
        embedding: [1, 0, 0],
        provenance: prov,
      };
      await store.putTheme(theme);

      await index.rebuild(store);
    });

    it('retrieves themes, facts, episodes, and entities via embedding', async () => {
      const query: MemoryQuery = {
        embedding: [1, 0, 0],
        max_hops: 2,
        limit: 20,
        min_similarity: 0.5,
        include_invalidated: false,
      };

      const result = await retrieveMemory(store, index, query);
      expect(result.themes).toHaveLength(1);
      expect(result.themes[0].label).toBe('People');
      expect(result.facts).toHaveLength(1);
      expect(result.episodes).toHaveLength(1);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('respects min_similarity', async () => {
      const query: MemoryQuery = {
        embedding: [0, 1, 0], // orthogonal to stored embeddings
        max_hops: 2,
        limit: 20,
        min_similarity: 0.9,
        include_invalidated: false,
      };

      const result = await retrieveMemory(store, index, query);
      expect(result.themes).toHaveLength(0);
      expect(result.facts).toHaveLength(0);
    });
  });

  describe('entity-based retrieval', () => {
    it('retrieves subgraph and related facts', async () => {
      const a: Entity = {
        id: crypto.randomUUID(),
        name: 'A',
        entity_type: 'concept',
        attributes: {},
        provenance: prov,
        created_at: now,
        updated_at: now,
      };
      const b: Entity = {
        id: crypto.randomUUID(),
        name: 'B',
        entity_type: 'concept',
        attributes: {},
        provenance: prov,
        created_at: now,
        updated_at: now,
      };
      await store.putEntity(a);
      await store.putEntity(b);

      const rel: Relationship = {
        id: crypto.randomUUID(),
        source_id: a.id,
        target_id: b.id,
        relation_type: 'knows',
        weight: 1,
        attributes: {},
        valid_from: now,
        provenance: prov,
      };
      await store.putRelationship(rel);

      const fact: SemanticFact = {
        id: crypto.randomUUID(),
        content: 'A knows B',
        source_episode_ids: [],
        entity_ids: [a.id, b.id],
        provenance: prov,
        valid_from: now,
      };
      await store.putFact(fact);

      await index.rebuild(store);

      const query: MemoryQuery = {
        entity_ids: [a.id],
        max_hops: 1,
        limit: 20,
        min_similarity: 0.5,
        include_invalidated: false,
      };

      const result = await retrieveMemory(store, index, query);
      expect(result.entities).toHaveLength(2);
      expect(result.relationships).toHaveLength(1);
      expect(result.facts).toHaveLength(1);
    });

    it('deduplicates facts shared across multiple entities', async () => {
      const e1: Entity = {
        id: crypto.randomUUID(),
        name: 'X',
        entity_type: 'concept',
        attributes: {},
        provenance: prov,
        created_at: now,
        updated_at: now,
      };
      const e2: Entity = {
        id: crypto.randomUUID(),
        name: 'Y',
        entity_type: 'concept',
        attributes: {},
        provenance: prov,
        created_at: now,
        updated_at: now,
      };
      await store.putEntity(e1);
      await store.putEntity(e2);

      const rel: Relationship = {
        id: crypto.randomUUID(),
        source_id: e1.id,
        target_id: e2.id,
        relation_type: 'related',
        weight: 1,
        attributes: {},
        valid_from: now,
        provenance: prov,
      };
      await store.putRelationship(rel);

      // Single fact referencing both entities — should appear only once
      const sharedFact: SemanticFact = {
        id: crypto.randomUUID(),
        content: 'X and Y are related',
        source_episode_ids: [],
        entity_ids: [e1.id, e2.id],
        provenance: prov,
        valid_from: now,
      };
      await store.putFact(sharedFact);
      await index.rebuild(store);

      const result = await retrieveMemory(store, index, {
        entity_ids: [e1.id],
        max_hops: 1,
        limit: 50,
        min_similarity: 0.5,
        include_invalidated: false,
      });

      // Fact is found via both e1 and e2, but must appear exactly once
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].id).toBe(sharedFact.id);
    });
  });

  describe('tag-only retrieval', () => {
    const seedFact = async (
      target: InMemoryMemoryStore,
      overrides: Partial<SemanticFact> = {},
    ): Promise<SemanticFact> => {
      const fact: SemanticFact = {
        id: crypto.randomUUID(),
        content: 'Some lesson worth keeping.',
        source_episode_ids: [],
        entity_ids: [],
        provenance: prov,
        valid_from: now,
        tags: [],
        ...overrides,
      };
      await target.putFact(fact);
      return fact;
    };

    it('returns facts whose tags intersect query.tags', async () => {
      const lessonA = await seedFact(store, { content: 'A', tags: ['lesson', 'graph:research-v1'] });
      const lessonB = await seedFact(store, { content: 'B', tags: ['lesson', 'graph:research-v1'] });
      await seedFact(store, { content: 'untagged' });
      await seedFact(store, { content: 'wrong tag', tags: ['warning'] });

      const result = await retrieveMemory(store, index, {
        tags: ['lesson'],
        max_hops: 2,
        limit: 20,
        min_similarity: 0.5,
        include_invalidated: false,
      });

      const ids = new Set(result.facts.map((f) => f.id));
      expect(ids).toEqual(new Set([lessonA.id, lessonB.id]));
      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
    });

    it('matches on any tag, not all tags', async () => {
      const lessonA = await seedFact(store, { content: 'A', tags: ['lesson'] });
      const lessonB = await seedFact(store, { content: 'B', tags: ['warning'] });

      const result = await retrieveMemory(store, index, {
        tags: ['lesson', 'warning'],
        max_hops: 2,
        limit: 20,
        min_similarity: 0.5,
        include_invalidated: false,
      });

      const ids = new Set(result.facts.map((f) => f.id));
      expect(ids).toEqual(new Set([lessonA.id, lessonB.id]));
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await seedFact(store, { content: `lesson ${i}`, tags: ['lesson'] });
      }

      const result = await retrieveMemory(store, index, {
        tags: ['lesson'],
        max_hops: 2,
        limit: 3,
        min_similarity: 0.5,
        include_invalidated: false,
      });

      expect(result.facts).toHaveLength(3);
    });

    it('applies temporal validity — excludes invalidated facts', async () => {
      await seedFact(store, {
        content: 'still valid',
        tags: ['lesson'],
      });
      await seedFact(store, {
        content: 'invalidated',
        tags: ['lesson'],
        valid_until: new Date(now.getTime() - 1000),
      });

      const result = await retrieveMemory(store, index, {
        tags: ['lesson'],
        valid_at: now,
        max_hops: 2,
        limit: 20,
        min_similarity: 0.5,
        include_invalidated: false,
      });

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].content).toBe('still valid');
    });

    it('attaches themes when present on matching facts', async () => {
      const theme: Theme = {
        id: crypto.randomUUID(),
        label: 'Research Lessons',
        description: 'distilled methodology guidance',
        fact_ids: [],
        provenance: prov,
      };
      await store.putTheme(theme);

      await seedFact(store, {
        content: 'Cite primary sources.',
        tags: ['lesson'],
        theme_id: theme.id,
      });

      const result = await retrieveMemory(store, index, {
        tags: ['lesson'],
        max_hops: 2,
        limit: 20,
        min_similarity: 0.5,
        include_invalidated: false,
      });

      expect(result.themes).toHaveLength(1);
      expect(result.themes[0].id).toBe(theme.id);
    });

    it('returns empty result for tags with no matches', async () => {
      await seedFact(store, { content: 'A', tags: ['lesson'] });

      const result = await retrieveMemory(store, index, {
        tags: ['nonexistent'],
        max_hops: 2,
        limit: 20,
        min_similarity: 0.5,
        include_invalidated: false,
      });

      expect(result.facts).toEqual([]);
    });
  });
});
