/**
 * Adaptive Memory Compressor
 *
 * A CompressionStage that intelligently prioritizes memory content
 * based on hierarchy signals: theme size, fact recency, and optional
 * query relevance. Operates only on segments with role 'memory'.
 *
 * @module memory/adaptive-compressor
 */

import type { CompressionStage, PromptSegment, StageContext, StageResult } from '../pipeline/types.js';

export interface AdaptiveCompressionOptions {
  /** Boost facts created within this many days (default: 7). */
  recencyBoostDays?: number;
  /** Recency multiplier for priority (default: 2.0). */
  recencyMultiplier?: number;
  /** Maximum facts to include per theme (default: 10). */
  maxFactsPerTheme?: number;
  /** Minimum content length to process (shorter segments pass through). */
  minContentLength?: number;
}

interface ParsedTheme {
  id: string;
  label: string;
  description: string;
  fact_ids: string[];
}

interface ParsedFact {
  id: string;
  content: string;
  valid_from: string | Date;
  [key: string]: unknown;
}

interface MemoryStructure {
  themes?: ParsedTheme[];
  facts?: ParsedFact[];
  entities?: unknown[];
  relationships?: unknown[];
}

function isMemoryStructure(data: unknown): data is MemoryStructure {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.themes) || Array.isArray(obj.facts);
}

/**
 * Creates an adaptive memory compression stage.
 *
 * Processes segments with `role === 'memory'`. Non-memory segments pass
 * through unchanged. Memory segments are expected to contain JSON with
 * a MemoryPayload-like structure (themes, facts, entities, relationships).
 *
 * The stage prioritizes facts by theme size and recency, truncates to
 * maxFactsPerTheme per theme, and re-serializes as compact JSON.
 */
export function createAdaptiveMemoryStage(options?: AdaptiveCompressionOptions): CompressionStage {
  const recencyBoostDays = options?.recencyBoostDays ?? 7;
  const recencyMultiplier = options?.recencyMultiplier ?? 2.0;
  const maxFactsPerTheme = options?.maxFactsPerTheme ?? 10;
  const minContentLength = options?.minContentLength ?? 0;

  return {
    name: 'adaptive-memory',

    execute(segments: PromptSegment[], _context: StageContext): StageResult {
      const processed = segments.map((segment) => {
        // Only process memory segments
        if (segment.role !== 'memory') return segment;

        // Skip locked segments
        if (segment.locked) return segment;

        // Skip short content
        if (segment.content.length < minContentLength) return segment;

        // Try to parse as JSON
        let data: unknown;
        try {
          data = JSON.parse(segment.content);
        } catch {
          // Invalid JSON — pass through unchanged
          return segment;
        }

        // Check for expected structure
        if (!isMemoryStructure(data)) return segment;

        const themes = data.themes ?? [];
        const facts = data.facts ?? [];

        // If no facts, pass through
        if (facts.length === 0) return segment;

        // Build theme-size map: themeId → number of fact_ids
        const themeSizeMap = new Map<string, number>();
        for (const theme of themes) {
          themeSizeMap.set(theme.id, theme.fact_ids?.length ?? 0);
        }

        // Build fact → theme mapping
        const factThemeMap = new Map<string, string>();
        for (const theme of themes) {
          for (const factId of theme.fact_ids ?? []) {
            factThemeMap.set(factId, theme.id);
          }
        }

        const now = Date.now();
        const recencyCutoff = now - recencyBoostDays * 24 * 60 * 60 * 1000;

        // Score each fact
        const scoredFacts = facts.map((fact) => {
          const themeId = fact.theme_id as string | undefined ?? factThemeMap.get(fact.id);
          const themeSize = themeId ? (themeSizeMap.get(themeId) ?? 1) : 1;

          // Base priority: theme size (larger themes = more important facts)
          let priority = themeSize;

          // Recency boost
          const validFrom = fact.valid_from instanceof Date
            ? fact.valid_from.getTime()
            : new Date(fact.valid_from).getTime();

          if (!isNaN(validFrom) && validFrom >= recencyCutoff) {
            priority *= recencyMultiplier;
          }

          return { fact, priority, themeId };
        });

        // Truncate per theme: keep only maxFactsPerTheme per theme
        const themeFactCounts = new Map<string, number>();
        // Sort by priority descending first so we keep the best ones
        scoredFacts.sort((a, b) => b.priority - a.priority);

        const keptFacts: Array<{ fact: ParsedFact; priority: number }> = [];
        for (const item of scoredFacts) {
          const tId = item.themeId ?? '__no_theme__';
          const count = themeFactCounts.get(tId) ?? 0;
          if (count < maxFactsPerTheme) {
            themeFactCounts.set(tId, count + 1);
            keptFacts.push({ fact: item.fact, priority: item.priority });
          }
        }

        // Already sorted by priority descending from above
        const reorderedFacts = keptFacts.map((item) => item.fact);

        // Rebuild the structure with reordered/truncated facts
        const output: MemoryStructure = { ...data };
        output.facts = reorderedFacts;

        // Compact JSON — no pretty-printing
        const compressed = JSON.stringify(output);

        return {
          ...segment,
          content: compressed,
        };
      });

      return { segments: processed };
    },
  };
}
