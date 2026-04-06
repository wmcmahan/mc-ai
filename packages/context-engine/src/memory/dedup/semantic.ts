/**
 * Semantic Deduplication
 *
 * Embedding-based near-duplicate detection via cosine similarity.
 * Requires an EmbeddingProvider — semantic features are disabled
 * without one. Supports pre-computed embeddings for sync pipeline
 * execution.
 *
 * @module memory/dedup/semantic
 */

import type { EmbeddingProvider } from '../../providers/types.js';
import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';

export interface SemanticDedupOptions {
  /** Cosine similarity threshold for duplicate detection (default 0.90). */
  threshold?: number;
  /** Minimum character length for comparison (default 20). */
  minLength?: number;
  /** Embedding provider (required). */
  provider: EmbeddingProvider;
  /** Pre-computed embeddings keyed by text content. */
  precomputed?: Map<string, number[]>;
}

/**
 * Pre-compute embeddings for all paragraph-level content in segments.
 * Call this async function before pipeline.compress() to enable
 * synchronous semantic dedup inside the pipeline.
 */
export async function precomputeEmbeddings(
  segments: PromptSegment[],
  provider: EmbeddingProvider,
  minLength: number = 20,
): Promise<Map<string, number[]>> {
  const texts: string[] = [];
  const textSet = new Set<string>();

  for (const seg of segments) {
    const paragraphs = seg.content.includes('\n\n')
      ? seg.content.split('\n\n')
      : seg.content.split('\n');

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length >= minLength && !textSet.has(trimmed)) {
        texts.push(trimmed);
        textSet.add(trimmed);
      }
    }
  }

  if (texts.length === 0) return new Map();

  const vectors = await provider.embed(texts);
  const map = new Map<string, number[]>();
  for (let i = 0; i < texts.length; i++) {
    map.set(texts[i], vectors[i]);
  }
  return map;
}

/**
 * Create a pipeline stage that deduplicates paragraphs by semantic similarity.
 *
 * Uses pre-computed embeddings when available; otherwise skips paragraphs
 * without embeddings (does not call the provider at runtime since the
 * pipeline is synchronous).
 */
export function createSemanticDedupStage(options: SemanticDedupOptions): CompressionStage {
  const threshold = options.threshold ?? 0.90;
  const minLength = options.minLength ?? 20;
  const precomputed = options.precomputed;

  return {
    name: 'semantic-dedup',
    execute(segments: PromptSegment[], _context: StageContext) {
      if (!precomputed || precomputed.size === 0) {
        // No pre-computed embeddings — pass through (graceful degradation)
        return { segments };
      }

      // Collect all paragraphs across segments
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

      // Build vectors for eligible paragraphs
      const vectors: (number[] | null)[] = allParagraphs.map(p => {
        const trimmed = p.text.trim();
        if (trimmed.length < minLength) return null;
        return precomputed.get(trimmed) ?? null;
      });

      // Pairwise comparison — mark duplicates (keep longer)
      const removed = new Set<number>();

      for (let i = 0; i < allParagraphs.length; i++) {
        if (removed.has(i)) continue;
        const vecA = vectors[i];
        if (!vecA) continue;

        for (let j = i + 1; j < allParagraphs.length; j++) {
          if (removed.has(j)) continue;
          const vecB = vectors[j];
          if (!vecB) continue;

          const sim = cosineSimilarity(vecA, vecB);
          if (sim >= threshold) {
            // Keep the longer paragraph (more information content)
            if (allParagraphs[i].text.length >= allParagraphs[j].text.length) {
              removed.add(j);
            } else {
              removed.add(i);
              break;
            }
          }
        }
      }

      // Reconstruct segments
      const keptBySegment = new Map<number, string[]>();
      for (let i = 0; i < segments.length; i++) {
        keptBySegment.set(i, []);
      }

      for (let i = 0; i < allParagraphs.length; i++) {
        if (!removed.has(i)) {
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

// ─── Cosine Similarity (private, reimplemented) ───────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
