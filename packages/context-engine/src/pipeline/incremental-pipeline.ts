/**
 * Incremental Compression Pipeline
 *
 * Wraps the batch pipeline to avoid re-compressing unchanged segments
 * between turns. Uses FNV-1a content hashing to detect changes and
 * caches compressed output for stable segments.
 *
 * Supports cross-segment cache awareness: stages with scope 'cross-segment'
 * are re-run on ALL segments whenever any segment changes, while per-segment
 * stages cache individually.
 *
 * @module pipeline/incremental-pipeline
 */

import type {
  CompressionStage,
  PipelineConfig,
  PipelineInput,
  PipelineResult,
  PipelineMetrics,
  PromptSegment,
} from './types.js';
import { createPipeline } from './pipeline.js';
import { aggregateMetrics, computeStageMetrics } from './metrics.js';
import { fnv1a } from '../memory/dedup/exact.js';

// --- Types ---

/** State carried between incremental pipeline turns. */
export interface PipelineState {
  /** Segment ID -> content hash from the previous turn. */
  segmentHashes: Map<string, number>;
  /** Segment ID -> compressed segment from the previous turn (final output after all stages). */
  compressedSegments: Map<string, PromptSegment>;
  /** Segment ID -> output after per-segment stages only. */
  perSegmentOutputs: Map<string, PromptSegment>;
  /** Aggregate metrics from the previous turn. */
  lastMetrics: PipelineMetrics;
  /** Turn counter (starts at 1). */
  turnNumber: number;
}

/** Configuration for the incremental pipeline. */
export interface IncrementalPipelineConfig extends PipelineConfig {
  /**
   * Segments whose content hash hasn't changed between turns
   * reuse cached compressed output. Default: true.
   */
  enableCaching?: boolean;
}

/** Result of an incremental compression call. */
export interface IncrementalResult {
  result: PipelineResult;
  state: PipelineState;
  /** Number of segments that were reused from cache. */
  cachedSegmentCount: number;
  /** Number of segments that were freshly compressed. */
  freshSegmentCount: number;
}

// --- Implementation ---

/**
 * Partition stages into per-segment and cross-segment groups.
 */
function partitionStages(stages: CompressionStage[]): {
  perSegmentStages: CompressionStage[];
  crossSegmentStages: CompressionStage[];
} {
  const perSegmentStages: CompressionStage[] = [];
  const crossSegmentStages: CompressionStage[] = [];

  for (const stage of stages) {
    if (stage.scope === 'cross-segment') {
      crossSegmentStages.push(stage);
    } else {
      perSegmentStages.push(stage);
    }
  }

  return { perSegmentStages, crossSegmentStages };
}

/**
 * Create an incremental compression pipeline that caches compressed
 * output for unchanged segments between turns.
 *
 * Supports cross-segment cache awareness: stages marked with
 * `scope: 'cross-segment'` are re-run on all segments whenever any
 * segment's per-segment output changes, while per-segment stages
 * cache individually.
 *
 * @example
 * ```ts
 * const pipeline = createIncrementalPipeline({
 *   stages: [createFormatStage(), createFuzzyDedupStage()],
 *   enableCaching: true,
 * });
 *
 * // First turn — all segments compressed
 * const turn1 = pipeline.compress({ segments, budget });
 *
 * // Second turn — only changed segments re-compressed through per-segment stages;
 * // cross-segment stages re-run if any segment changed
 * const turn2 = pipeline.compress({ segments, budget }, turn1.state);
 * ```
 */
export function createIncrementalPipeline(config: IncrementalPipelineConfig) {
  const enableCaching = config.enableCaching ?? true;

  return {
    compress(input: PipelineInput, previousState?: PipelineState): IncrementalResult {
      // Compute hashes for all current segments
      const currentHashes = new Map<string, number>();
      for (const seg of input.segments) {
        currentHashes.set(seg.id, fnv1a(seg.content));
      }

      const { perSegmentStages, crossSegmentStages } = partitionStages(config.stages);
      const hasCrossSegmentStages = crossSegmentStages.length > 0;

      // If no previous state or caching disabled: run all stages partitioned,
      // caching per-segment outputs for future incremental runs.
      if (!previousState || !enableCaching) {
        // Run per-segment stages on all segments
        const perSegmentOutputs = new Map<string, PromptSegment>();
        let perSegOrdered: PromptSegment[];
        let perSegMetrics: PipelineMetrics | undefined;

        if (perSegmentStages.length > 0) {
          const perSegPipeline = createPipeline({ ...config, stages: perSegmentStages });
          const perSegResult = perSegPipeline.compress(input);
          perSegOrdered = perSegResult.segments;
          perSegMetrics = perSegResult.metrics;
        } else {
          perSegOrdered = [...input.segments];
        }

        for (const seg of perSegOrdered) {
          perSegmentOutputs.set(seg.id, seg);
        }

        // Run cross-segment stages (if any) on per-segment output
        let finalSegments: PromptSegment[];
        let crossMetrics: PipelineMetrics | undefined;

        if (crossSegmentStages.length > 0) {
          const crossPipeline = createPipeline({ ...config, stages: crossSegmentStages });
          const crossResult = crossPipeline.compress({ ...input, segments: perSegOrdered });
          finalSegments = crossResult.segments;
          crossMetrics = crossResult.metrics;
        } else {
          finalSegments = perSegOrdered;
        }

        const compressedSegments = new Map<string, PromptSegment>();
        for (const seg of finalSegments) {
          compressedSegments.set(seg.id, seg);
        }

        // Combine metrics from both phases
        const allStageMetrics = [
          ...(perSegMetrics?.stages ?? []),
          ...(crossMetrics?.stages ?? []),
        ];
        const metrics = allStageMetrics.length > 0
          ? aggregateMetrics(allStageMetrics)
          : aggregateMetrics([computeStageMetrics('(none)', 0, 0, 0)]);

        const state: PipelineState = {
          segmentHashes: currentHashes,
          compressedSegments,
          perSegmentOutputs,
          lastMetrics: metrics,
          turnNumber: (previousState?.turnNumber ?? 0) + 1,
        };

        return {
          result: { segments: finalSegments, metrics },
          state,
          cachedSegmentCount: 0,
          freshSegmentCount: input.segments.length,
        };
      }

      // --- Incremental path with caching ---

      // Determine which segments are cached vs fresh based on hash
      const cachedIds = new Set<string>();
      const freshIds = new Set<string>();

      for (const seg of input.segments) {
        const currentHash = currentHashes.get(seg.id)!;
        const previousHash = previousState.segmentHashes.get(seg.id);

        if (
          previousHash !== undefined &&
          previousHash === currentHash &&
          previousState.perSegmentOutputs.has(seg.id)
        ) {
          cachedIds.add(seg.id);
        } else {
          freshIds.add(seg.id);
        }
      }

      // --- Per-segment phase ---
      const perSegmentOutputs = new Map<string, PromptSegment>();
      let anyPerSegmentFresh = false;

      if (perSegmentStages.length > 0) {
        // Reuse cached per-segment outputs for unchanged segments
        for (const seg of input.segments) {
          if (cachedIds.has(seg.id)) {
            perSegmentOutputs.set(seg.id, previousState.perSegmentOutputs.get(seg.id)!);
          }
        }

        // Run fresh segments through per-segment stages
        const freshSegments = input.segments.filter(s => freshIds.has(s.id));
        if (freshSegments.length > 0) {
          anyPerSegmentFresh = true;
          const perSegPipeline = createPipeline({ ...config, stages: perSegmentStages });
          const freshInput: PipelineInput = { ...input, segments: freshSegments };
          const freshResult = perSegPipeline.compress(freshInput);
          for (const seg of freshResult.segments) {
            perSegmentOutputs.set(seg.id, seg);
          }
        }
      } else {
        // No per-segment stages: per-segment output is the raw input
        for (const seg of input.segments) {
          if (cachedIds.has(seg.id)) {
            perSegmentOutputs.set(seg.id, previousState.perSegmentOutputs.get(seg.id)!);
          } else {
            anyPerSegmentFresh = true;
            perSegmentOutputs.set(seg.id, seg);
          }
        }
      }

      // Assemble per-segment outputs in original order
      const perSegmentOrdered = input.segments.map(s => perSegmentOutputs.get(s.id)!);

      // --- Cross-segment phase ---
      let outputSegments: PromptSegment[];

      if (!hasCrossSegmentStages) {
        // No cross-segment stages: per-segment outputs ARE the final outputs
        outputSegments = perSegmentOrdered;
      } else if (anyPerSegmentFresh || freshIds.size > 0) {
        // Something changed: re-run cross-segment stages on ALL segments
        const crossPipeline = createPipeline({ ...config, stages: crossSegmentStages });
        const crossInput: PipelineInput = { ...input, segments: perSegmentOrdered };
        const crossResult = crossPipeline.compress(crossInput);
        outputSegments = crossResult.segments;
      } else {
        // Everything cached: reuse final output from previous state
        outputSegments = input.segments.map(
          s => previousState.compressedSegments.get(s.id) ?? perSegmentOutputs.get(s.id)!,
        );
      }

      // --- Build metrics ---
      const allCached = freshIds.size === 0;
      let metrics: PipelineMetrics;

      if (allCached) {
        metrics = buildCachedOnlyMetrics(config);
      } else {
        // Build approximate metrics
        const stageMetricsList = config.stages.map(stage => {
          if (cachedIds.size > 0 && stage.scope !== 'cross-segment') {
            // Per-segment stage: only fresh segments went through
            return computeStageMetrics(stage.name, 0, 0, 0);
          }
          return computeStageMetrics(stage.name, 0, 0, 0);
        });
        metrics = aggregateMetrics(
          stageMetricsList.length > 0
            ? stageMetricsList
            : [computeStageMetrics('(none)', 0, 0, 0)],
        );
      }

      // --- Build new state ---
      const compressedSegments = new Map<string, PromptSegment>();
      for (const seg of outputSegments) {
        compressedSegments.set(seg.id, seg);
      }

      const state: PipelineState = {
        segmentHashes: currentHashes,
        compressedSegments,
        perSegmentOutputs,
        lastMetrics: metrics,
        turnNumber: previousState.turnNumber + 1,
      };

      return {
        result: { segments: outputSegments, metrics },
        state,
        cachedSegmentCount: cachedIds.size,
        freshSegmentCount: freshIds.size,
      };
    },
  };
}

/**
 * Build metrics representing zero pipeline work (all segments cached).
 */
function buildCachedOnlyMetrics(config: PipelineConfig): PipelineMetrics {
  const stageMetrics = config.stages.map(stage =>
    computeStageMetrics(stage.name, 0, 0, 0),
  );

  if (stageMetrics.length === 0) {
    return aggregateMetrics([computeStageMetrics('(none)', 0, 0, 0)]);
  }

  return aggregateMetrics(stageMetrics);
}
