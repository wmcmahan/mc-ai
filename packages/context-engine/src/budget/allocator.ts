/**
 * Budget Allocator
 *
 * Distributes a token budget across prompt segments based on priority
 * weighting. Locked segments get their exact allocation (non-negotiable).
 * Remaining budget is distributed by priority weight with surplus
 * redistribution.
 *
 * @module budget/allocator
 */

import type { TokenCounter } from '../providers/types.js';
import type { CompressionStage, PromptSegment, BudgetConfig, StageContext } from '../pipeline/types.js';
import { countSegmentTokens } from './counter.js';

export interface AllocationResult {
  /** Allocated tokens per segment (segment ID → token budget). */
  allocations: Map<string, number>;
  /** Segment IDs that exceed their allocation after truncation. */
  overflow: string[];
}

/**
 * Allocate token budget across segments.
 *
 * Algorithm:
 * 1. Subtract outputReserve from total budget
 * 2. Locked segments get their exact token count (non-negotiable)
 * 3. Remaining budget distributed to mutable segments by priority weight
 * 4. Segments under budget donate surplus for redistribution
 */
export function allocateBudget(
  segments: PromptSegment[],
  budget: BudgetConfig,
  counter: TokenCounter,
  model?: string,
): AllocationResult {
  const counts = countSegmentTokens(segments, counter, model);
  const availableBudget = budget.maxTokens - budget.outputReserve;
  const allocations = new Map<string, number>();

  // 1. Locked segments: exact allocation
  let lockedTotal = 0;
  for (const seg of segments) {
    if (seg.locked) {
      const tokens = counts.get(seg.id) ?? 0;
      allocations.set(seg.id, tokens);
      lockedTotal += tokens;
    }
  }

  // 2. Mutable segments: distribute remaining by priority
  const mutableBudget = Math.max(0, availableBudget - lockedTotal);
  const mutableSegments = segments.filter(s => !s.locked);
  const totalPriority = mutableSegments.reduce((sum, s) => sum + s.priority, 0);

  if (totalPriority === 0 || mutableSegments.length === 0) {
    // No mutable segments or zero priority — nothing to allocate
    return { allocations, overflow: [] };
  }

  // First pass: proportional allocation
  const firstPass = new Map<string, number>();
  for (const seg of mutableSegments) {
    const share = (seg.priority / totalPriority) * mutableBudget;
    const actual = counts.get(seg.id) ?? 0;
    // Don't allocate more than the segment actually needs
    const allocated = Math.min(Math.floor(share), actual);
    firstPass.set(seg.id, allocated);
  }

  // Second pass: redistribute surplus from under-budget segments
  let surplus = 0;
  const needsMore: { id: string; want: number; have: number }[] = [];

  for (const seg of mutableSegments) {
    const allocated = firstPass.get(seg.id) ?? 0;
    const actual = counts.get(seg.id) ?? 0;

    if (allocated >= actual) {
      // Under budget: donate surplus
      surplus += allocated - actual;
      firstPass.set(seg.id, actual);
    } else if (actual > allocated) {
      needsMore.push({ id: seg.id, want: actual - allocated, have: allocated });
    }
  }

  // Distribute surplus proportionally to segments that need more
  if (surplus > 0 && needsMore.length > 0) {
    const totalWant = needsMore.reduce((sum, n) => sum + n.want, 0);
    for (const need of needsMore) {
      const bonus = Math.min(
        Math.floor((need.want / totalWant) * surplus),
        need.want,
      );
      firstPass.set(need.id, need.have + bonus);
    }
  }

  // Finalize allocations
  const overflow: string[] = [];
  for (const seg of mutableSegments) {
    const allocated = firstPass.get(seg.id) ?? 0;
    const actual = counts.get(seg.id) ?? 0;
    allocations.set(seg.id, allocated);
    if (actual > allocated) {
      overflow.push(seg.id);
    }
  }

  return { allocations, overflow };
}

/**
 * Create a pipeline stage that enforces budget allocations by truncating
 * segments that exceed their allocation.
 */
export function createAllocatorStage(): CompressionStage {
  return {
    name: 'budget-allocator',
    execute(segments: PromptSegment[], context: StageContext) {
      const { allocations } = allocateBudget(
        segments,
        context.budget,
        context.tokenCounter,
        context.model,
      );

      const output = segments.map(seg => {
        const budget = allocations.get(seg.id);
        if (budget === undefined) return seg;

        const currentTokens = context.tokenCounter.countTokens(seg.content, context.model);
        if (currentTokens <= budget) return seg;

        // Truncate to fit budget
        const truncated = truncateToTokens(seg.content, budget, context.tokenCounter, context.model);
        return { ...seg, content: truncated };
      });

      return { segments: output };
    },
  };
}

/**
 * Truncate text to fit within a token budget.
 * Uses binary search on character position for efficiency.
 */
function truncateToTokens(
  text: string,
  maxTokens: number,
  counter: TokenCounter,
  model?: string,
): string {
  if (maxTokens <= 0) return '';

  // Binary search for the right character cutoff
  let low = 0;
  let high = text.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const tokens = counter.countTokens(text.slice(0, mid), model);

    if (tokens <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const truncated = text.slice(0, best);
  if (best < text.length) {
    return truncated + '\n... [truncated]';
  }
  return truncated;
}
