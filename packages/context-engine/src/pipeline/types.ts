/**
 * Pipeline Types
 *
 * Core type definitions for the composable compression pipeline.
 * All configuration types are Zod-validated at the pipeline boundary.
 *
 * @module pipeline/types
 */

import { z } from 'zod';
import type { TokenCounter } from '../providers/types.js';

// --- Zod Schemas ---

export const SegmentRoleSchema = z.enum([
  'system',
  'memory',
  'tools',
  'history',
  'user',
  'custom',
]);

export const PromptSegmentSchema = z.object({
  /** Unique identifier for this segment. */
  id: z.string(),
  /** The text content of this segment. */
  content: z.string(),
  /** Semantic role of this segment in the prompt. */
  role: SegmentRoleSchema,
  /** Priority weight (higher = more important, gets more budget). */
  priority: z.number().min(0).default(1),
  /** If true, this segment bypasses all compression stages. */
  locked: z.boolean().default(false),
  /** Arbitrary metadata (passed through stages unchanged). */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const BudgetConfigSchema = z.object({
  /** Maximum total tokens for the compressed output. */
  maxTokens: z.number().int().positive(),
  /** Tokens reserved for model output generation. */
  outputReserve: z.number().int().min(0).default(0),
  /** Per-segment budget overrides (segment id → max tokens). */
  segmentBudgets: z.record(z.string(), z.number().int().positive()).optional(),
});

// --- Inferred Types ---

export type SegmentRole = z.infer<typeof SegmentRoleSchema>;
export type PromptSegment = z.infer<typeof PromptSegmentSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

// --- Non-Schema Types ---

/** Per-stage compression metrics. */
export interface StageMetrics {
  /** Stage name. */
  name: string;
  /** Tokens before this stage ran. */
  tokensIn: number;
  /** Tokens after this stage ran. */
  tokensOut: number;
  /** Compression ratio (tokensOut / tokensIn). 1.0 = no change. */
  ratio: number;
  /** Wall-clock time for this stage in milliseconds. */
  durationMs: number;
  /** Whether the stage encountered an error and passed through. */
  error?: boolean;
}

/** Aggregated pipeline metrics across all stages. */
export interface PipelineMetrics {
  /** Total tokens in the original input. */
  totalTokensIn: number;
  /** Total tokens in the compressed output. */
  totalTokensOut: number;
  /** Overall compression ratio. */
  overallRatio: number;
  /** Total reduction as a percentage (e.g. 45.2 = 45.2% reduction). */
  reductionPercent: number;
  /** Total pipeline wall-clock time in milliseconds. */
  totalDurationMs: number;
  /** Per-stage breakdown. */
  stages: StageMetrics[];
}

/** Context available to each compression stage. */
export interface StageContext {
  /** Token counter for measuring compression. */
  tokenCounter: TokenCounter;
  /** Budget configuration. */
  budget: BudgetConfig;
  /** Target model (for model-aware compression). */
  model?: string;
  /** Whether debug mode is enabled (source maps, extra logging). */
  debug?: boolean;
}

/** Result returned by a single compression stage. */
export interface StageResult {
  /** The segments after compression. */
  segments: PromptSegment[];
  /** Metrics for this stage (computed by the pipeline, not the stage). */
  metrics?: StageMetrics;
}

/** A single composable compression stage. */
export interface CompressionStage {
  /** Human-readable stage name (used in metrics). */
  readonly name: string;
  /** Whether this stage operates per-segment or across segments. Default: 'per-segment'. */
  readonly scope?: 'per-segment' | 'cross-segment';
  /** Execute the compression stage on the given segments. */
  execute(segments: PromptSegment[], context: StageContext): StageResult;
}

/** Configuration for creating a pipeline. */
export interface PipelineConfig {
  /** Ordered list of compression stages. */
  stages: CompressionStage[];
  /** Custom token counter (defaults to model-family estimator). */
  tokenCounter?: TokenCounter;
  /** Enable debug mode (source maps, extra metrics). */
  debug?: boolean;
}

/** Input to a pipeline compression call. */
export interface PipelineInput {
  /** The prompt segments to compress. */
  segments: PromptSegment[];
  /** Token budget for the output. */
  budget: BudgetConfig;
  /** Target model string (passed to token counter and format selector). */
  model?: string;
}

/** Source map entry: maps a compressed segment back to its original. */
export interface SourceMapEntry {
  segmentId: string;
  original: string;
  compressed: string;
}

/** Result returned by the pipeline. */
export interface PipelineResult {
  /** Compressed segments. */
  segments: PromptSegment[];
  /** Aggregated pipeline metrics. */
  metrics: PipelineMetrics;
  /** Debug source map (only populated when debug mode is enabled). */
  sourceMap?: SourceMapEntry[];
}
