/**
 * Pipeline Optimizer
 *
 * Convenience API that creates an optimized pipeline from a preset
 * or latency budget. Users who don't want to manually compose stages
 * can use this. Advanced users continue with `createPipeline` directly.
 *
 * @module budget/optimizer
 */

import type { CompressionProvider, EmbeddingProvider, TokenCounter } from '../providers/types.js';
import type { CompressionStage } from '../pipeline/types.js';
import { createPipeline } from '../pipeline/pipeline.js';
import { createFormatStage } from '../format/serializer.js';
import { createExactDedupStage } from '../memory/dedup/exact.js';
import { createFuzzyDedupStage } from '../memory/dedup/fuzzy.js';
import { createCotDistillationStage } from '../pruning/cot-distillation.js';
import { createHeuristicPruningStage } from '../pruning/heuristic.js';
import { createAllocatorStage } from './allocator.js';
import { createHierarchyFormatterStage } from '../memory/hierarchy/hierarchy-formatter.js';
import { createGraphSerializerStage } from '../memory/graph/serializer.js';
import { createFormatSelectorStage } from '../routing/format-selector.js';

export type PipelinePreset = 'fast' | 'balanced' | 'maximum';

export interface OptimizerOptions {
  /** Pipeline preset (default: auto-select from maxLatencyMs or 'balanced'). */
  preset?: PipelinePreset;
  /** Auto-select preset based on latency budget in milliseconds. */
  maxLatencyMs?: number;
  /** Compression provider for ML-powered pruning (enables 'maximum' preset). */
  compressionProvider?: CompressionProvider;
  /** Embedding provider for semantic dedup (used in 'maximum' preset). */
  embeddingProvider?: EmbeddingProvider;
  /** Target model for model-aware format selection. */
  model?: string;
  /** Enable debug mode (source maps). */
  debug?: boolean;
  /** Custom token counter. */
  tokenCounter?: TokenCounter;
}

export interface OptimizedPipeline {
  /** The configured pipeline. */
  pipeline: ReturnType<typeof createPipeline>;
  /** The selected preset. */
  preset: PipelinePreset;
  /** The stages included in the pipeline. */
  stageNames: string[];
}

/**
 * Create an optimized pipeline from a preset or latency budget.
 *
 * Presets:
 * - `fast`: format + exact dedup + allocator (~2-5ms)
 * - `balanced`: fast + fuzzy dedup + heuristic pruning + CoT distillation (~10-20ms)
 * - `maximum`: balanced + hierarchy/graph formatters + format selector + allocator (~50-200ms)
 *
 * Note: Semantic dedup and self-information pruning require pre-computed
 * embeddings/scores and are not included in presets. Use `createPipeline`
 * directly for those.
 */
export function createOptimizedPipeline(options?: OptimizerOptions): OptimizedPipeline {
  const preset = options?.preset ?? selectPreset(options?.maxLatencyMs);
  const stages = buildStages(preset, options);

  const pipeline = createPipeline({
    stages,
    tokenCounter: options?.tokenCounter,
    debug: options?.debug,
  });

  return {
    pipeline,
    preset,
    stageNames: stages.map(s => s.name),
  };
}

/**
 * Select a preset based on latency budget.
 */
function selectPreset(maxLatencyMs?: number): PipelinePreset {
  if (maxLatencyMs === undefined) return 'balanced';
  if (maxLatencyMs <= 5) return 'fast';
  if (maxLatencyMs <= 50) return 'balanced';
  return 'maximum';
}

/**
 * Build the ordered stage list for a preset.
 */
function buildStages(
  preset: PipelinePreset,
  options?: OptimizerOptions,
): CompressionStage[] {
  const stages: CompressionStage[] = [];

  // Maximum: add specialized formatters + model-aware selection
  if (preset === 'maximum') {
    stages.push(createHierarchyFormatterStage());
    stages.push(createGraphSerializerStage());
    if (options?.model) {
      stages.push(createFormatSelectorStage());
    }
  }

  // All presets: format compression
  stages.push(createFormatStage());

  // All presets: exact dedup
  stages.push(createExactDedupStage());

  // Balanced + Maximum: fuzzy dedup, CoT distillation, heuristic pruning
  if (preset === 'balanced' || preset === 'maximum') {
    stages.push(createFuzzyDedupStage());
    stages.push(createCotDistillationStage());
    stages.push(createHeuristicPruningStage());
  }

  // All presets: budget allocator (always last)
  stages.push(createAllocatorStage());

  return stages;
}
