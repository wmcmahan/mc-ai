import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMemoryStore } from '../src/index.js';
import { batchGetFallback } from '../src/store/batch-mixin.js';
import type { Entity, SemanticFact, Episode, Theme, Provenance } from '../src/index.js';

const now = new Date();
const prov: Provenance = { source: 'system', created_at: now };

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: crypto.randomUUID(),
    name: 'Test Entity',
    entity_type: 'concept',
    attributes: {},
    provenance: prov,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeFact(overrides: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id: crypto.randomUUID(),
    content: 'Test fact',
    source_episode_ids: [],
    entity_ids: [],
    provenance: prov,
    valid_from: now,
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: crypto.randomUUID(),
    topic: 'Test episode',
    messages: [],
    started_at: now,
    ended_at: now,
    fact_ids: [],
    provenance: prov,
    ...overrides,
  };
}

function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    id: crypto.randomUUID(),
    label: 'Test Theme',
    description: '',
    fact_ids: [],
    provenance: prov,
    ...overrides,
  };
}

describe('Batch Store Operations', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  describe('getEntities', () => {
    it('returns all requested entities', async () => {
      const e1 = makeEntity({ name: 'Alice' });
      const e2 = makeEntity({ name: 'Bob' });
      await store.putEntity(e1);
      await store.putEntity(e2);

      const result = await store.getEntities([e1.id, e2.id]);
      expect(result.size).toBe(2);
      expect(result.get(e1.id)).toEqual(e1);
      expect(result.get(e2.id)).toEqual(e2);
    });

    it('silently omits missing IDs', async () => {
      const e1 = makeEntity({ name: 'Alice' });
      await store.putEntity(e1);

      const result = await store.getEntities([e1.id, 'nonexistent']);
      expect(result.size).toBe(1);
      expect(result.has('nonexistent')).toBe(false);
    });

    it('returns empty map for empty ID list', async () => {
      const result = await store.getEntities([]);
      expect(result.size).toBe(0);
    });

    it('returns empty map when no IDs match', async () => {
      const result = await store.getEntities(['a', 'b', 'c']);
      expect(result.size).toBe(0);
    });

    it('returns cloned entities (mutation safe)', async () => {
      const e1 = makeEntity({ name: 'Alice' });
      await store.putEntity(e1);

      const result = await store.getEntities([e1.id]);
      const retrieved = result.get(e1.id)!;
      retrieved.name = 'Mutated';

      const fresh = await store.getEntity(e1.id);
      expect(fresh!.name).toBe('Alice');
    });
  });

  describe('getFacts', () => {
    it('returns all requested facts', async () => {
      const f1 = makeFact({ content: 'Fact 1' });
      const f2 = makeFact({ content: 'Fact 2' });
      await store.putFact(f1);
      await store.putFact(f2);

      const result = await store.getFacts([f1.id, f2.id]);
      expect(result.size).toBe(2);
      expect(result.get(f1.id)!.content).toBe('Fact 1');
    });

    it('silently omits missing IDs', async () => {
      const f1 = makeFact();
      await store.putFact(f1);

      const result = await store.getFacts([f1.id, 'missing']);
      expect(result.size).toBe(1);
    });
  });

  describe('getEpisodes', () => {
    it('returns all requested episodes', async () => {
      const ep1 = makeEpisode({ topic: 'Episode 1' });
      const ep2 = makeEpisode({ topic: 'Episode 2' });
      await store.putEpisode(ep1);
      await store.putEpisode(ep2);

      const result = await store.getEpisodes([ep1.id, ep2.id]);
      expect(result.size).toBe(2);
      expect(result.get(ep1.id)!.topic).toBe('Episode 1');
    });

    it('silently omits missing IDs', async () => {
      const result = await store.getEpisodes(['nonexistent']);
      expect(result.size).toBe(0);
    });
  });

  describe('getThemes', () => {
    it('returns all requested themes', async () => {
      const t1 = makeTheme({ label: 'Theme 1' });
      const t2 = makeTheme({ label: 'Theme 2' });
      await store.putTheme(t1);
      await store.putTheme(t2);

      const result = await store.getThemes([t1.id, t2.id]);
      expect(result.size).toBe(2);
      expect(result.get(t1.id)!.label).toBe('Theme 1');
    });

    it('handles duplicate IDs in input', async () => {
      const t1 = makeTheme({ label: 'Theme 1' });
      await store.putTheme(t1);

      const result = await store.getThemes([t1.id, t1.id, t1.id]);
      expect(result.size).toBe(1);
    });
  });
});

describe('batchGetFallback', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
  });

  it('fetches items in parallel using single-get', async () => {
    const e1 = makeEntity({ name: 'Alice' });
    const e2 = makeEntity({ name: 'Bob' });
    await store.putEntity(e1);
    await store.putEntity(e2);

    const result = await batchGetFallback(
      [e1.id, e2.id],
      (id) => store.getEntity(id),
    );
    expect(result.size).toBe(2);
    expect(result.get(e1.id)!.name).toBe('Alice');
  });

  it('omits null results from the map', async () => {
    const e1 = makeEntity({ name: 'Alice' });
    await store.putEntity(e1);

    const result = await batchGetFallback(
      [e1.id, 'missing'],
      (id) => store.getEntity(id),
    );
    expect(result.size).toBe(1);
    expect(result.has('missing')).toBe(false);
  });

  it('returns empty map for empty input', async () => {
    const result = await batchGetFallback(
      [],
      (id) => store.getEntity(id),
    );
    expect(result.size).toBe(0);
  });
});
