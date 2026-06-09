/**
 * Fact Sanitizer
 *
 * Optional pre-write hook applied to facts emitted by `reflection` nodes
 * before they reach the configured `MemoryWriter`. Lets callers redact
 * PII, drop policy-violating content, or substitute alternative wording
 * without bolting that logic onto the writer adapter itself.
 *
 * Returning the same `MemoryWriterFact` passes the fact through unchanged.
 * Returning a modified fact substitutes it. Returning `null` drops the
 * fact entirely — it never reaches the writer.
 *
 * Best-effort by contract: the runner logs and absorbs any error thrown
 * by a sanitizer so a downed PII service or buggy regex never blocks the
 * compound-learning loop. Errors fall through as "pass the fact unchanged."
 *
 * @module agent/fact-sanitizer
 */

import type { MemoryWriterFact } from './memory-writer.js';

/**
 * Pre-write hook for facts produced by a reflection node.
 *
 * @param fact - The candidate fact about to be written.
 * @returns
 *   - The fact (possibly modified) to keep it,
 *   - `null` to drop the fact silently,
 *   - or a promise resolving to either.
 */
export type FactSanitizer = (
  fact: MemoryWriterFact,
) => MemoryWriterFact | null | Promise<MemoryWriterFact | null>;
