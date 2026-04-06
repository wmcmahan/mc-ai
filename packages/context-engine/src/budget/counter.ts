/**
 * Token Counter
 *
 * Wraps a TokenCounter provider and provides utility functions
 * for counting tokens across prompt segments.
 *
 * @module budget/counter
 */

import type { TokenCounter } from '../providers/types.js';
import type { PromptSegment } from '../pipeline/types.js';
import { DefaultTokenCounter } from '../providers/defaults.js';

/**
 * Create a token counter, optionally wrapping a custom provider.
 * Falls back to the built-in model-family estimator.
 */
export function createTokenCounter(provider?: TokenCounter): TokenCounter {
  return provider ?? new DefaultTokenCounter();
}

/**
 * Count tokens for each segment, returning a map of segment ID → token count.
 */
export function countSegmentTokens(
  segments: PromptSegment[],
  counter: TokenCounter,
  model?: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const seg of segments) {
    counts.set(seg.id, counter.countTokens(seg.content, model));
  }
  return counts;
}

/**
 * Count total tokens across all segments.
 */
export function countTotalTokens(
  segments: PromptSegment[],
  counter: TokenCounter,
  model?: string,
): number {
  let total = 0;
  for (const seg of segments) {
    total += counter.countTokens(seg.content, model);
  }
  return total;
}
