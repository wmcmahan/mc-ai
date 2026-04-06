/**
 * Pruning Types
 *
 * Foundation types for token-level importance scoring and pruning.
 * Scorers produce scored tokens; the pruner selects the most
 * important ones within a budget.
 *
 * @module pruning/types
 */

/** A scored unit of text with its position for order-preserving reconstruction. */
export interface ScoredToken {
  /** The text content (word, whitespace, or punctuation). */
  text: string;
  /** Importance score (0.0 = expendable, 1.0 = critical). */
  score: number;
  /** Original position index for order-preserving reconstruction. */
  offset: number;
}

/** Optional cross-segment context for frequency-based scoring. */
export interface ScorerContext {
  /** Role of the segment being scored (for role-aware rules). */
  role?: string;
  /** Content of all segments (for cross-segment frequency analysis). */
  allContent?: string[];
  /** Query string for query-contrastive scoring. */
  query?: string;
}

/**
 * Pluggable token importance scorer.
 *
 * Implementations split content into tokens, score each by importance,
 * and return the scored array. The generic pruner uses these scores
 * to select which tokens to keep within a budget.
 */
export interface TokenScorer {
  score(content: string, context?: ScorerContext): ScoredToken[];
}
