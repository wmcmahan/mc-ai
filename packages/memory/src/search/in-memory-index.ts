/**
 * In-Memory Memory Index
 *
 * Brute-force cosine similarity search over stored embeddings.
 * Adequate for testing; production backends use pgvector HNSW.
 *
 * @module search/in-memory-index
 */

import type { Entity } from '../schemas/entity.js';
import type { SemanticFact } from '../schemas/semantic.js';
import type { Theme } from '../schemas/theme.js';
import type { Episode } from '../schemas/episode.js';
import type { MemoryStore } from '../interfaces/memory-store.js';
import type { MemoryIndex, ScoredResult, SearchOptions } from '../interfaces/memory-index.js';
import { cosineSimilarity } from '../utils/similarity.js';

interface IndexEntry<T> {
  item: T;
  embedding: number[];
}

export class InMemoryMemoryIndex implements MemoryIndex {
  private entityIndex: IndexEntry<Entity>[] = [];
  private factIndex: IndexEntry<SemanticFact>[] = [];
  private themeIndex: IndexEntry<Theme>[] = [];
  private episodeIndex: IndexEntry<Episode>[] = [];

  async searchEntities(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<Entity>[]> {
    return this.search(this.entityIndex, embedding, opts);
  }

  async searchFacts(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<SemanticFact>[]> {
    return this.search(this.factIndex, embedding, opts);
  }

  async searchThemes(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<Theme>[]> {
    return this.search(this.themeIndex, embedding, opts);
  }

  async searchEpisodes(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<Episode>[]> {
    return this.search(this.episodeIndex, embedding, opts);
  }

  async rebuild(store: MemoryStore): Promise<void> {
    // Rebuild entity index
    const entities = await store.findEntities({ include_invalidated: true, limit: 10_000 });
    this.entityIndex = entities
      .filter((e) => e.embedding)
      .map((e) => ({ item: e, embedding: e.embedding! }));

    // Rebuild fact index
    const facts = await store.findFacts({ include_invalidated: true, limit: 10_000 });
    this.factIndex = facts
      .filter((f) => f.embedding)
      .map((f) => ({ item: f, embedding: f.embedding! }));

    // Rebuild theme index
    const themes = await store.listThemes();
    this.themeIndex = themes
      .filter((t) => t.embedding)
      .map((t) => ({ item: t, embedding: t.embedding! }));

    // Rebuild episode index
    const episodes = await store.listEpisodes({ limit: 10_000 });
    this.episodeIndex = episodes
      .filter((e) => e.embedding)
      .map((e) => ({ item: e, embedding: e.embedding! }));
  }

  private search<T>(
    index: IndexEntry<T>[],
    queryEmbedding: number[],
    opts: SearchOptions = {},
  ): ScoredResult<T>[] {
    const { limit = 20, min_similarity = 0.5 } = opts;

    const scored: ScoredResult<T>[] = [];
    for (const entry of index) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      if (score >= min_similarity) {
        scored.push({ item: entry.item, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
