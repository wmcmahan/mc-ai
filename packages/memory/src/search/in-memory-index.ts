/**
 * In-Memory Memory Index
 *
 * Brute-force cosine similarity search over stored embeddings. O(n) per
 * query — adequate for testing and low-cardinality workloads. Switch to a
 * pgvector-backed adapter (HNSW indexed) once the index grows past ~10K
 * entries; the brute-force scan dominates query latency past that threshold.
 *
 * The class emits a one-shot console warning when rebuilt past
 * {@link IN_MEMORY_INDEX_WARN_THRESHOLD} so a runaway test fixture or
 * misconfigured production deployment surfaces the scaling cliff before
 * latency degrades silently.
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

/**
 * Threshold past which {@link InMemoryMemoryIndex.rebuild} emits a scaling
 * warning. Picked to align with the existing 10k findEntities/findFacts limit
 * applied inside `rebuild()`: hitting this size means you are at or above the
 * point where the brute-force scan stops being cheap.
 */
export const IN_MEMORY_INDEX_WARN_THRESHOLD = 10_000;

/** Construction options for {@link InMemoryMemoryIndex}. */
export interface InMemoryMemoryIndexOptions {
  /**
   * Expected embedding dimensionality. When set, every embedding indexed or
   * queried is checked against this value and a mismatch throws an
   * `EmbeddingDimensionMismatchError` immediately. Strongly recommended:
   * cosine similarity over mixed-dimension vectors produces silently incorrect
   * scores. Typically wired from the configured `EmbeddingProvider.dimensions`.
   */
  expectedDimensions?: number;
  /**
   * Suppress the one-shot console warning emitted when the index grows past
   * {@link IN_MEMORY_INDEX_WARN_THRESHOLD}. Default `false`. Set `true` only
   * if you have a deliberate reason to scale the brute-force index past 10k
   * entries (e.g. a stress test exercising the scan path).
   */
  silenceScaleWarning?: boolean;
}

/**
 * Raised when an embedding's length disagrees with the index's configured
 * `expectedDimensions`. This is almost always a misconfiguration bug — e.g.
 * a 512-dim embedding provider talking to a 1536-dim pgvector schema.
 */
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    public readonly context: string,
  ) {
    super(
      `Embedding dimension mismatch in ${context}: expected ${expected}, got ${actual}. ` +
      `Check that your EmbeddingProvider.dimensions matches the dimensionality of stored vectors.`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

export class InMemoryMemoryIndex implements MemoryIndex {
  private entityIndex: IndexEntry<Entity>[] = [];
  private factIndex: IndexEntry<SemanticFact>[] = [];
  private themeIndex: IndexEntry<Theme>[] = [];
  private episodeIndex: IndexEntry<Episode>[] = [];
  private readonly expectedDimensions?: number;
  private readonly silenceScaleWarning: boolean;
  /** One-shot guard so we don't spam logs on every subsequent rebuild. */
  private scaleWarningEmitted = false;

  constructor(options?: InMemoryMemoryIndexOptions) {
    this.expectedDimensions = options?.expectedDimensions;
    this.silenceScaleWarning = options?.silenceScaleWarning ?? false;
  }

  private assertDimension(embedding: number[], context: string): void {
    if (this.expectedDimensions === undefined) return;
    if (embedding.length !== this.expectedDimensions) {
      throw new EmbeddingDimensionMismatchError(this.expectedDimensions, embedding.length, context);
    }
  }

  async searchEntities(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<Entity>[]> {
    this.assertDimension(embedding, 'searchEntities');
    return this.search(this.entityIndex, embedding, opts);
  }

  async searchFacts(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<SemanticFact>[]> {
    this.assertDimension(embedding, 'searchFacts');
    return this.search(this.factIndex, embedding, opts);
  }

  async searchThemes(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<Theme>[]> {
    this.assertDimension(embedding, 'searchThemes');
    return this.search(this.themeIndex, embedding, opts);
  }

  async searchEpisodes(embedding: number[], opts?: SearchOptions): Promise<ScoredResult<Episode>[]> {
    this.assertDimension(embedding, 'searchEpisodes');
    return this.search(this.episodeIndex, embedding, opts);
  }

  async rebuild(store: MemoryStore): Promise<void> {
    const buildEntries = <T extends { embedding?: number[] | null }>(
      records: T[],
      kind: 'entity' | 'fact' | 'theme' | 'episode',
    ): IndexEntry<T>[] => {
      const entries: IndexEntry<T>[] = [];
      for (const record of records) {
        if (!record.embedding) continue;
        // Throw on dimension mismatch so a stale index — e.g. a 1536-dim record
        // left behind after a provider swap to 512-dim — surfaces immediately
        // instead of producing silently wrong cosine scores at query time.
        this.assertDimension(record.embedding, `rebuild (${kind})`);
        entries.push({ item: record, embedding: record.embedding });
      }
      return entries;
    };

    const entities = await store.findEntities({ include_invalidated: true, limit: 10_000 });
    this.entityIndex = buildEntries(entities, 'entity');

    const facts = await store.findFacts({ include_invalidated: true, limit: 10_000 });
    this.factIndex = buildEntries(facts, 'fact');

    const themes = await store.listThemes();
    this.themeIndex = buildEntries(themes, 'theme');

    const episodes = await store.listEpisodes({ limit: 10_000 });
    this.episodeIndex = buildEntries(episodes, 'episode');

    this.maybeWarnAboutScale();
  }

  /**
   * Emit a one-shot warning when the brute-force index has crossed
   * {@link IN_MEMORY_INDEX_WARN_THRESHOLD}. Past this size, swap to the
   * pgvector-backed adapter — cosine scans don't get faster with more RAM.
   */
  private maybeWarnAboutScale(): void {
    if (this.scaleWarningEmitted || this.silenceScaleWarning) return;
    const total =
      this.entityIndex.length +
      this.factIndex.length +
      this.themeIndex.length +
      this.episodeIndex.length;
    if (total < IN_MEMORY_INDEX_WARN_THRESHOLD) return;

    this.scaleWarningEmitted = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[@cycgraph/memory] InMemoryMemoryIndex now holds ${total} embeddings ` +
      `(threshold: ${IN_MEMORY_INDEX_WARN_THRESHOLD}). Brute-force cosine ` +
      `scans are O(n) per query — switch to a pgvector-backed adapter for ` +
      `production workloads. Suppress this warning with ` +
      `{ silenceScaleWarning: true } in the constructor options.`,
    );
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
