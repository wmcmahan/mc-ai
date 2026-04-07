/**
 * Exact Deduplication
 *
 * Hash-based exact duplicate removal using FNV-1a. Splits content
 * into paragraphs, hashes each, and keeps only the first occurrence.
 * Works across multiple segments (cross-segment dedup).
 *
 * @module memory/dedup/exact
 */

import type { CompressionStage, PromptSegment, StageContext } from '../../pipeline/types.js';

export interface DedupResult {
  /** Unique items after deduplication. */
  unique: string[];
  /** Number of duplicates removed. */
  removed: number;
}

/**
 * Deduplicate an array of strings, keeping the first occurrence of each.
 * Uses FNV-1a hash for fast, deterministic duplicate detection.
 */
export function dedup(items: string[]): DedupResult {
  const seen = new Set<number>();
  const unique: string[] = [];
  let removed = 0;

  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed === '') {
      unique.push(item);
      continue;
    }

    const hash = fnv1a(trimmed);
    if (seen.has(hash)) {
      removed++;
    } else {
      seen.add(hash);
      unique.push(item);
    }
  }

  return { unique, removed };
}

/**
 * Create a pipeline stage that performs exact deduplication.
 *
 * Splits each segment's content by double-newline (paragraph boundaries),
 * deduplicates across all mutable segments, and reassembles.
 */
export function createExactDedupStage(): CompressionStage {
  return {
    name: 'exact-dedup',
    execute(segments: PromptSegment[], _context: StageContext) {
      // Collect all paragraphs across segments with their origin
      const seen = new Set<number>();
      const output: PromptSegment[] = [];

      for (const seg of segments) {
        const hasDoubleLine = seg.content.includes('\n\n');
        const paragraphs = splitParagraphs(seg.content);
        const kept: string[] = [];

        for (const para of paragraphs) {
          const trimmed = para.trim();
          if (trimmed === '') {
            kept.push(para);
            continue;
          }

          const hash = fnv1a(trimmed);
          if (!seen.has(hash)) {
            seen.add(hash);
            kept.push(para);
          }
        }

        const separator = hasDoubleLine ? '\n\n' : '\n';
        output.push({ ...seg, content: kept.join(separator) });
      }

      return { segments: output };
    },
  };
}

/**
 * Split content into paragraphs (double-newline separated).
 * Preserves line-based content by also splitting on single newlines
 * when no double-newlines are present.
 */
function splitParagraphs(content: string): string[] {
  if (content.includes('\n\n')) {
    return content.split('\n\n');
  }
  return content.split('\n');
}

/**
 * FNV-1a hash (32-bit). Fast, deterministic, good distribution.
 * Pure TypeScript — no crypto dependency.
 */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0; // FNV prime, force 32-bit integer
  }
  return hash >>> 0; // Ensure unsigned
}
