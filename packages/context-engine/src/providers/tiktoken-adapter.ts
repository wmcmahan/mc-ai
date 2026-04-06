/**
 * Tiktoken Adapter
 *
 * Optional provider adapter that wraps a BPE encode function
 * (from `gpt-tokenizer` or similar) into a `TokenCounter`.
 *
 * Usage:
 * ```ts
 * import { encode } from 'gpt-tokenizer';
 * import { createTiktokenCounter } from '@mcai/context-engine';
 *
 * const counter = createTiktokenCounter(encode);
 * ```
 *
 * @module providers/tiktoken-adapter
 */

import type { TokenCounter } from './types.js';

/**
 * Create a TokenCounter that uses an external BPE encode function.
 *
 * The encode function must take a string and return an array of token IDs.
 * This adapter counts the length of that array.
 *
 * @param encode - BPE encode function (e.g., from `gpt-tokenizer`).
 * @returns A TokenCounter using exact BPE tokenization.
 */
export function createTiktokenCounter(
  encode: (text: string) => number[],
): TokenCounter {
  return {
    countTokens(text: string): number {
      if (text.length === 0) return 0;
      return encode(text).length;
    },
  };
}
