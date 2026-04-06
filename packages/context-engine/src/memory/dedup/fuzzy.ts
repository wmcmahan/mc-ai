/**
 * Fuzzy Deduplication
 *
 * Trigram Jaccard similarity for near-duplicate detection.
 * Catches duplicates that differ by a few words — what exact
 * dedup misses. Runs after exact dedup to reduce the O(n^2) input.
 *
 * @module memory/dedup/fuzzy
 */

import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';

export interface FuzzyDedupResult {
  /** Items after deduplication. */
  unique: string[];
  /** Number of near-duplicates removed. */
  removed: number;
}

export interface FuzzyDedupOptions {
  /** Jaccard similarity threshold (0-1, default 0.85). */
  threshold?: number;
  /** Minimum character length for comparison (default 20). */
  minLength?: number;
}

/**
 * Generate the set of character trigrams from a string.
 */
export function trigramSet(text: string): Set<string> {
  const lower = text.toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.add(lower.slice(i, i + 3));
  }
  return trigrams;
}

/**
 * Compute Jaccard similarity between two trigram sets.
 * Returns 0-1 where 1 = identical trigram sets.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Run pairwise fuzzy comparison and return the set of removed indices.
 * Shared between fuzzyDedup() and the pipeline stage to avoid logic duplication.
 */
function computeRemovedIndices(
  items: string[],
  threshold: number,
  minLength: number,
): Set<number> {
  const removed = new Set<number>();

  // Pre-compute trigram sets for eligible items
  const trigramSets = items.map(item => {
    const trimmed = item.trim();
    if (trimmed.length < minLength) return null;
    return { text: trimmed, trigrams: trigramSet(trimmed) };
  });

  // Pairwise comparison — mark duplicates
  for (let i = 0; i < items.length; i++) {
    if (removed.has(i)) continue;
    const a = trigramSets[i];
    if (!a) continue;

    for (let j = i + 1; j < items.length; j++) {
      if (removed.has(j)) continue;
      const b = trigramSets[j];
      if (!b) continue;

      const sim = jaccardSimilarity(a.trigrams, b.trigrams);
      if (sim >= threshold) {
        if (a.text.length <= b.text.length) {
          removed.add(j);
        } else {
          removed.add(i);
          break;
        }
      }
    }
  }

  return removed;
}

/**
 * Deduplicate items by fuzzy similarity, keeping the shorter of duplicates.
 */
export function fuzzyDedup(items: string[], options?: FuzzyDedupOptions): FuzzyDedupResult {
  const threshold = options?.threshold ?? 0.85;
  const minLength = options?.minLength ?? 20;

  const removed = computeRemovedIndices(items, threshold, minLength);
  const unique = items.filter((_, i) => !removed.has(i));
  return { unique, removed: removed.size };
}

/**
 * Create a pipeline stage that performs fuzzy deduplication.
 *
 * Splits each segment by paragraph, deduplicates near-duplicates
 * across all segments, and reassembles.
 */
export function createFuzzyDedupStage(options?: FuzzyDedupOptions): CompressionStage {
  return {
    name: 'fuzzy-dedup',
    scope: 'cross-segment' as const,
    execute(segments: PromptSegment[], _context: StageContext) {
      // Collect all paragraphs with their segment origin
      const allParagraphs: { segIdx: number; text: string }[] = [];
      const segmentMeta: { hasDoubleLine: boolean }[] = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const hasDoubleLine = seg.content.includes('\n\n');
        segmentMeta.push({ hasDoubleLine });
        const paragraphs = hasDoubleLine ? seg.content.split('\n\n') : seg.content.split('\n');
        for (const para of paragraphs) {
          allParagraphs.push({ segIdx: i, text: para });
        }
      }

      // Compute which paragraph indices are near-duplicates
      const texts = allParagraphs.map(p => p.text);
      const threshold = options?.threshold ?? 0.85;
      const minLength = options?.minLength ?? 20;
      const removedIndices = computeRemovedIndices(texts, threshold, minLength);

      // Reconstruct segments from kept paragraphs
      const keptBySegment = new Map<number, string[]>();
      for (let i = 0; i < segments.length; i++) {
        keptBySegment.set(i, []);
      }

      for (let i = 0; i < allParagraphs.length; i++) {
        if (!removedIndices.has(i)) {
          keptBySegment.get(allParagraphs[i].segIdx)!.push(allParagraphs[i].text);
        }
      }

      const output = segments.map((seg, i) => {
        const kept = keptBySegment.get(i) ?? [];
        const separator = segmentMeta[i].hasDoubleLine ? '\n\n' : '\n';
        return { ...seg, content: kept.join(separator) };
      });

      return { segments: output };
    },
  };
}
