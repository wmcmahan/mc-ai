/**
 * Consolidating Theme Clusterer
 *
 * Two-pass clustering: greedy assignment (same as SimpleThemeClusterer)
 * followed by a merge pass that consolidates highly similar themes.
 * Drop-in replacement for SimpleThemeClusterer.
 *
 * @module hierarchy/consolidating-theme-clusterer
 */

import type { SemanticFact } from '../schemas/semantic.js';
import type { Theme } from '../schemas/theme.js';
import type { ThemeClusterer } from '../interfaces/theme-clusterer.js';
import { cosineSimilarity } from '../utils/similarity.js';

export interface ConsolidatingThemeClustererOptions {
  /** Minimum similarity to assign a fact to an existing theme (default: 0.7). */
  assignmentThreshold?: number;
  /** Minimum similarity between two themes to merge them (default: 0.85). */
  mergeThreshold?: number;
  /** Soft cap on number of themes (no limit by default). */
  maxThemes?: number;
}

export class ConsolidatingThemeClusterer implements ThemeClusterer {
  private readonly assignmentThreshold: number;
  private readonly mergeThreshold: number;
  private readonly maxThemes?: number;

  constructor(options?: ConsolidatingThemeClustererOptions) {
    this.assignmentThreshold = options?.assignmentThreshold ?? 0.7;
    this.mergeThreshold = options?.mergeThreshold ?? 0.85;
    this.maxThemes = options?.maxThemes;
  }

  async cluster(facts: SemanticFact[], existingThemes: Theme[] = []): Promise<Theme[]> {
    let themes = existingThemes.map((t) => ({ ...t, fact_ids: [...t.fact_ids] }));

    // --- Pass 1: Greedy assignment (same as SimpleThemeClusterer) ---
    const factsWithEmbeddings = facts.filter((f) => f.embedding);
    if (facts.length > 0 && factsWithEmbeddings.length === 0) {
      return this.fallbackSingleTheme(facts, themes);
    }

    for (const fact of facts) {
      if (!fact.embedding) {
        this.assignToFallbackTheme(fact, themes);
        continue;
      }

      let bestTheme: Theme | null = null;
      let bestScore = -1;

      for (const theme of themes) {
        if (!theme.embedding) continue;
        const score = cosineSimilarity(fact.embedding, theme.embedding);
        if (score > bestScore) {
          bestScore = score;
          bestTheme = theme;
        }
      }

      if (bestTheme && bestScore >= this.assignmentThreshold) {
        bestTheme.fact_ids.push(fact.id);
      } else {
        themes.push({
          id: crypto.randomUUID(),
          label: fact.content.slice(0, 80),
          description: '',
          fact_ids: [fact.id],
          embedding: fact.embedding ? [...fact.embedding] : undefined,
          provenance: {
            source: 'system',
            created_at: new Date(),
          },
        });
      }
    }

    // --- Pass 2: Consolidation (merge similar themes) ---
    themes = this.mergePass(themes, this.mergeThreshold);

    // --- Enforce maxThemes cap ---
    if (this.maxThemes !== undefined) {
      while (themes.length > this.maxThemes) {
        const merged = this.mergeMostSimilarPair(themes);
        if (!merged) break; // No themes with embeddings to merge
        themes = merged;
      }
    }

    return themes;
  }

  /**
   * Repeatedly merge pairs above threshold until convergence.
   */
  private mergePass(themes: Theme[], threshold: number): Theme[] {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < themes.length; i++) {
        for (let j = i + 1; j < themes.length; j++) {
          const a = themes[i];
          const b = themes[j];
          if (!a.embedding || !b.embedding) continue;

          const sim = cosineSimilarity(a.embedding, b.embedding);
          if (sim >= threshold) {
            // Merge smaller into larger
            const [larger, smaller] = a.fact_ids.length >= b.fact_ids.length
              ? [a, b]
              : [b, a];

            larger.fact_ids = [...larger.fact_ids, ...smaller.fact_ids];
            larger.embedding = averageEmbeddings(larger.embedding!, smaller.embedding!);

            // Remove the smaller theme
            themes.splice(themes.indexOf(smaller), 1);
            changed = true;
            break; // Restart inner loop since indices shifted
          }
        }
        if (changed) break; // Restart outer loop
      }
    }
    return themes;
  }

  /**
   * Merge the two most similar themes (used for maxThemes enforcement).
   */
  private mergeMostSimilarPair(themes: Theme[]): Theme[] | null {
    let bestI = -1;
    let bestJ = -1;
    let bestSim = -1;

    for (let i = 0; i < themes.length; i++) {
      for (let j = i + 1; j < themes.length; j++) {
        if (!themes[i].embedding || !themes[j].embedding) continue;
        const sim = cosineSimilarity(themes[i].embedding!, themes[j].embedding!);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestI < 0) return null;

    const a = themes[bestI];
    const b = themes[bestJ];
    const [larger, smaller] = a.fact_ids.length >= b.fact_ids.length
      ? [a, b]
      : [b, a];

    larger.fact_ids = [...larger.fact_ids, ...smaller.fact_ids];
    larger.embedding = averageEmbeddings(larger.embedding!, smaller.embedding!);

    return themes.filter((t) => t !== smaller);
  }

  private fallbackSingleTheme(facts: SemanticFact[], themes: Theme[]): Theme[] {
    let general = themes.find((t) => t.label === 'General');
    if (!general) {
      general = {
        id: crypto.randomUUID(),
        label: 'General',
        description: 'Default theme for facts without embeddings',
        fact_ids: [],
        provenance: { source: 'system', created_at: new Date() },
      };
      themes.push(general);
    }
    for (const fact of facts) {
      general.fact_ids.push(fact.id);
    }
    return themes;
  }

  private assignToFallbackTheme(fact: SemanticFact, themes: Theme[]): void {
    let general = themes.find((t) => t.label === 'General');
    if (!general) {
      general = {
        id: crypto.randomUUID(),
        label: 'General',
        description: 'Default theme for facts without embeddings',
        fact_ids: [],
        provenance: { source: 'system', created_at: new Date() },
      };
      themes.push(general);
    }
    general.fact_ids.push(fact.id);
  }
}

function averageEmbeddings(a: number[], b: number[]): number[] {
  return a.map((val, i) => (val + b[i]) / 2);
}
