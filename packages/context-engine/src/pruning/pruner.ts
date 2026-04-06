/**
 * Generic Score-Based Pruner
 *
 * Given scored tokens and a budget, selects the most important tokens
 * that fit within the budget while preserving original order.
 *
 * @module pruning/pruner
 */

import type { TokenCounter } from '../providers/types.js';
import type { CompressionStage, PromptSegment, StageContext } from '../pipeline/types.js';
import type { ScoredToken, TokenScorer, ScorerContext } from './types.js';

/**
 * Prune scored tokens to fit within a token budget.
 *
 * Algorithm:
 * 1. Sort by score descending (most important first)
 * 2. Greedily select tokens until budget is reached
 * 3. Re-sort selected tokens by original offset
 * 4. Join preserving whitespace structure
 */
export function pruneByScore(
  tokens: ScoredToken[],
  maxTokens: number,
  counter: TokenCounter,
  model?: string,
): string {
  if (tokens.length === 0) return '';

  // Sort by importance (highest first)
  const sorted = [...tokens].sort((a, b) => b.score - a.score);

  // Greedily select tokens within budget.
  // Track running token count incrementally to avoid O(n^2) re-counting.
  const selected: ScoredToken[] = [];
  let runningCount = 0;

  for (const token of sorted) {
    const tokenCount = counter.countTokens(token.text, model);
    if (runningCount + tokenCount <= maxTokens) {
      selected.push(token);
      runningCount += tokenCount;
    }
  }

  // Re-sort by original position
  selected.sort((a, b) => a.offset - b.offset);

  // Join — collapse excessive whitespace at gaps
  let result = '';
  let lastOffset = -1;

  for (const token of selected) {
    if (lastOffset >= 0 && token.offset > lastOffset + 1) {
      // Gap in offsets — ensure at least one space
      if (result.length > 0 && !result.endsWith(' ') && !result.endsWith('\n') && !token.text.startsWith(' ') && !token.text.startsWith('\n')) {
        result += ' ';
      }
    }
    result += token.text;
    lastOffset = token.offset;
  }

  return result.trim();
}

/**
 * Create a pipeline compression stage that prunes tokens by importance scores.
 *
 * For each segment, scores all tokens via the provided scorer, then
 * prunes to fit within the segment's share of the budget.
 */
export function createPruningStage(scorer: TokenScorer): CompressionStage {
  return {
    name: 'score-pruning',
    execute(segments: PromptSegment[], context: StageContext) {
      const totalBudget = context.budget.maxTokens - (context.budget.outputReserve ?? 0);
      const allContent = segments.map(s => s.content);

      // Distribute budget proportionally by current token count
      const counts = segments.map(s => context.tokenCounter.countTokens(s.content, context.model));
      const totalTokens = counts.reduce((a, b) => a + b, 0);

      const output = segments.map((seg, i) => {
        const segBudget = context.budget.segmentBudgets?.[seg.id]
          ?? (totalTokens > 0 ? Math.floor((counts[i] / totalTokens) * totalBudget) : totalBudget);

        // Skip if already within budget
        if (counts[i] <= segBudget) return seg;

        const scorerContext: ScorerContext = {
          role: seg.role,
          allContent,
        };

        const scored = scorer.score(seg.content, scorerContext);
        const pruned = pruneByScore(scored, segBudget, context.tokenCounter, context.model);

        return { ...seg, content: pruned };
      });

      return { segments: output };
    },
  };
}
