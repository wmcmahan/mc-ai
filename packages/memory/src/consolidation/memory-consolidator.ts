/**
 * Memory Consolidator
 *
 * Prunes and deduplicates memory records to keep the store within
 * budget. Supports near-duplicate fact merging (via embedding
 * similarity), time-decay scoring, and episode pruning.
 *
 * @module consolidation/memory-consolidator
 */

import type { MemoryStore } from '../interfaces/memory-store.js';
import type { MemoryIndex } from '../interfaces/memory-index.js';
import type { SemanticFact } from '../schemas/semantic.js';

export interface ConsolidationOptions {
  /** Max facts to retain. Oldest/lowest-scoring pruned first. */
  maxFacts?: number;
  /** Max episodes to retain. */
  maxEpisodes?: number;
  /** Decay half-life in days (default 30). */
  decayHalfLifeDays?: number;
  /** Cosine similarity threshold for deduplicating facts (default 0.9). */
  dedupThreshold?: number;
  /** Whether to hard-delete or soft-delete (invalidate). Default: 'soft'. */
  deleteMode?: 'soft' | 'hard';
}

export interface ConsolidationReport {
  /** Number of near-duplicate facts merged. */
  factsDeduped: number;
  /** Number of facts pruned due to low decay score. */
  factsDecayed: number;
  /** Number of episodes pruned. */
  episodesPruned: number;
  /** Number of themes whose fact_ids were updated. */
  themesCleanedUp: number;
  /** Number of themes deleted because all facts were pruned. */
  themesRemoved: number;
  /** Total records removed or invalidated. */
  totalReclaimed: number;
}

export class MemoryConsolidator {
  constructor(
    private readonly store: MemoryStore,
    private readonly index: MemoryIndex,
    private readonly options: ConsolidationOptions = {},
  ) {}

  async consolidate(): Promise<ConsolidationReport> {
    const report: ConsolidationReport = {
      factsDeduped: 0,
      factsDecayed: 0,
      episodesPruned: 0,
      themesCleanedUp: 0,
      themesRemoved: 0,
      totalReclaimed: 0,
    };

    const prunedFactIds = new Set<string>();

    // 1. Deduplication
    await this.dedup(report, prunedFactIds);

    // 2. Decay scoring & pruning
    await this.decay(report, prunedFactIds);

    // 3. Episode pruning
    await this.pruneEpisodes(report);

    // 4. Theme cascade cleanup
    await this.cascadeThemes(prunedFactIds, report);

    return report;
  }

  private async dedup(report: ConsolidationReport, prunedFactIds: Set<string>): Promise<void> {
    const dedupThreshold = this.options.dedupThreshold ?? 0.9;
    const deleteMode = this.options.deleteMode ?? 'soft';

    const facts = await this.store.findFacts({ include_invalidated: false, limit: 10_000 });
    const processed = new Set<string>();

    for (const fact of facts) {
      if (!fact.embedding || processed.has(fact.id)) continue;

      const similar = await this.index.searchFacts(fact.embedding, {
        min_similarity: dedupThreshold,
        limit: 100,
      });

      for (const { item: candidate } of similar) {
        if (candidate.id === fact.id) continue;
        if (processed.has(candidate.id)) continue;
        if (candidate.invalidated_by) continue;

        // Determine which to keep
        const keepFact = this.pickKeeper(fact, candidate);
        const loseFact = keepFact.id === fact.id ? candidate : fact;

        if (deleteMode === 'soft') {
          await this.store.putFact({
            ...loseFact,
            invalidated_by: keepFact.id,
          });
        } else {
          await this.store.deleteFact(loseFact.id);
        }

        processed.add(loseFact.id);
        prunedFactIds.add(loseFact.id);
        report.factsDeduped++;
        report.totalReclaimed++;
      }

      processed.add(fact.id);
    }
  }

  private pickKeeper(a: SemanticFact, b: SemanticFact): SemanticFact {
    // Keep the one with more source episodes
    if (a.source_episode_ids.length !== b.source_episode_ids.length) {
      return a.source_episode_ids.length > b.source_episode_ids.length ? a : b;
    }
    // If equal, keep the newer one
    return a.valid_from >= b.valid_from ? a : b;
  }

  private async decay(report: ConsolidationReport, prunedFactIds: Set<string>): Promise<void> {
    const { maxFacts, decayHalfLifeDays = 30, deleteMode = 'soft' } = this.options;
    if (maxFacts === undefined) return;

    const facts = await this.store.findFacts({ include_invalidated: false, limit: 10_000 });
    if (facts.length <= maxFacts) return;

    const now = Date.now();
    const halfLife = decayHalfLifeDays;

    const scored = facts.map((fact) => {
      const ageDays = (now - fact.valid_from.getTime()) / (1000 * 60 * 60 * 24);
      const decayScore = (fact.access_count ?? 1) * Math.pow(2, -ageDays / halfLife);
      return { fact, decayScore };
    });

    // Sort ascending by score (lowest first = candidates for pruning)
    scored.sort((a, b) => a.decayScore - b.decayScore);

    const toPrune = scored.length - maxFacts;
    for (let i = 0; i < toPrune; i++) {
      const { fact } = scored[i];
      if (deleteMode === 'soft') {
        await this.store.putFact({
          ...fact,
          invalidated_by: 'consolidation:decay',
        });
      } else {
        await this.store.deleteFact(fact.id);
      }
      prunedFactIds.add(fact.id);
      report.factsDecayed++;
      report.totalReclaimed++;
    }
  }

  private async cascadeThemes(prunedFactIds: Set<string>, report: ConsolidationReport): Promise<void> {
    if (prunedFactIds.size === 0) return;

    const themes = await this.store.listThemes();

    for (const theme of themes) {
      const filtered = theme.fact_ids.filter((id) => !prunedFactIds.has(id));

      if (filtered.length === theme.fact_ids.length) continue;

      if (filtered.length === 0) {
        await this.store.deleteTheme(theme.id);
        report.themesRemoved++;
        report.totalReclaimed++;
      } else {
        const embedding = await this.computeCentroid(filtered);
        await this.store.putTheme({
          ...theme,
          fact_ids: filtered,
          embedding,
        });
        report.themesCleanedUp++;
      }
    }
  }

  private async computeCentroid(factIds: string[]): Promise<number[] | undefined> {
    const factsMap = await this.store.getFacts(factIds);
    const embeddings: number[][] = [];

    for (const fact of factsMap.values()) {
      if (fact.embedding) {
        embeddings.push(fact.embedding);
      }
    }

    if (embeddings.length === 0) return undefined;

    const dims = embeddings[0].length;
    const centroid = new Array<number>(dims).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dims; i++) {
        centroid[i] += emb[i];
      }
    }

    for (let i = 0; i < dims; i++) {
      centroid[i] /= embeddings.length;
    }

    return centroid;
  }

  private async pruneEpisodes(report: ConsolidationReport): Promise<void> {
    const { maxEpisodes } = this.options;
    if (maxEpisodes === undefined) return;

    // listEpisodes returns newest first by default; we want oldest first for pruning
    const episodes = await this.store.listEpisodes({ limit: 10_000 });
    if (episodes.length <= maxEpisodes) return;

    // Reverse so oldest is first
    episodes.reverse();

    const toPrune = episodes.length - maxEpisodes;
    for (let i = 0; i < toPrune; i++) {
      await this.store.deleteEpisode(episodes[i].id);
      report.episodesPruned++;
      report.totalReclaimed++;
    }
  }
}
