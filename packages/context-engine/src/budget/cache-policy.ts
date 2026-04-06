/**
 * Cache-Aware Prefix Locking
 *
 * Pre-processor that marks qualifying segments as locked to preserve
 * API prompt cache hits (Anthropic, OpenAI, local RadixAttention).
 * Locked segments bypass all compression stages, ensuring byte-identical
 * prefixes across calls.
 *
 * This is NOT a pipeline stage — the pipeline splits locked/mutable
 * before stages run. Apply this before `pipeline.compress()`.
 *
 * @module budget/cache-policy
 */

import type { PromptSegment } from '../pipeline/types.js';
import { fnv1a } from '../memory/dedup/exact.js';

export interface CachePolicyOptions {
  /** Lock segments with role 'system' (default true). */
  lockSystem?: boolean;
  /** Lock segments with role 'tools' (default true). */
  lockTools?: boolean;
  /** Lock the first N segments regardless of role (default 0). */
  lockFirstN?: number;
  /** Custom predicate for additional locking rules. */
  lockPredicate?: (segment: PromptSegment) => boolean;
}

/**
 * Apply cache policy to segments, marking qualifying ones as locked.
 *
 * Returns new segment objects (does not mutate originals).
 *
 * @example
 * ```ts
 * const locked = applyCachePolicy(segments, { lockSystem: true, lockTools: true });
 * const result = pipeline.compress({ segments: locked, budget });
 * ```
 */
export function applyCachePolicy(
  segments: PromptSegment[],
  options?: CachePolicyOptions,
): PromptSegment[] {
  const lockSystem = options?.lockSystem ?? true;
  const lockTools = options?.lockTools ?? true;
  const lockFirstN = options?.lockFirstN ?? 0;
  const lockPredicate = options?.lockPredicate;

  return segments.map((seg, i) => {
    let shouldLock = seg.locked; // preserve existing locks

    if (!shouldLock && lockSystem && seg.role === 'system') shouldLock = true;
    if (!shouldLock && lockTools && seg.role === 'tools') shouldLock = true;
    if (!shouldLock && i < lockFirstN) shouldLock = true;
    if (!shouldLock && lockPredicate?.(seg)) shouldLock = true;

    return shouldLock !== seg.locked ? { ...seg, locked: shouldLock } : seg;
  });
}

/**
 * Compute FNV-1a hashes of segment contents for cross-turn cache stability.
 *
 * Compare hash sets between turns to measure cache hit rate:
 * `hitRate = intersection(current, previous).size / previous.size`
 */
export function computePrefixHashes(segments: PromptSegment[]): Set<number> {
  const hashes = new Set<number>();
  for (const seg of segments) {
    if (seg.locked) {
      hashes.add(fnv1a(seg.content));
    }
  }
  return hashes;
}

/**
 * Measure cache hit rate between two turns.
 *
 * @returns Hit rate as 0-1 (1.0 = all previous locked segments are identical).
 */
export function measureCacheHitRate(
  current: Set<number>,
  previous: Set<number>,
): number {
  if (previous.size === 0) return 1.0;
  let hits = 0;
  for (const hash of previous) {
    if (current.has(hash)) hits++;
  }
  return hits / previous.size;
}

/**
 * Compute a Map from segment ID to FNV-1a hash of segment content.
 * Useful for cross-turn cache stability diagnostics.
 */
export function computeSegmentHashMap(segments: PromptSegment[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const seg of segments) {
    map.set(seg.id, fnv1a(seg.content));
  }
  return map;
}
