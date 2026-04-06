/**
 * Assertion Type Definitions
 *
 * Result interfaces for the zod structural and semantic judge
 * assertion modules. These types are consumed by the drift
 * calculator and the reporter.
 *
 * @module assertions/types
 */

// ─── Zod Structural Assertion ──────────────────────────────────────

/** A single type mismatch between expected and actual parameter types. */
export interface TypeMismatch {
  /** Dot-path to the mismatched parameter (e.g., "query" or "options.limit"). */
  param: string;

  /** The type expected by the schema. */
  expected: string;

  /** The type actually received. */
  received: string;
}

/**
 * Result of validating an LLM-generated tool call against an expected
 * schema. Checks structure and types only — never exact string values.
 */
export interface ZodStructuralResult {
  /** Whether the tool call passes structural validation. */
  passed: boolean;

  /** The expected tool name. */
  toolName: string;

  /** Parameter names that were required but missing from the actual call. */
  missingParams: string[];

  /** Parameters whose types did not match the schema. */
  typeMismatches: TypeMismatch[];
}

// ─── Semantic Judge Assertion ──────────────────────────────────────

/**
 * Result of an LLM-as-judge semantic evaluation.
 *
 * The judge scores whether the actual output meets the expected
 * intent, factual consistency, or logical coherence.
 */
export interface SemanticJudgeResult {
  /** Whether the output passed the semantic threshold. */
  passed: boolean;

  /** Score from 0.0 (complete mismatch) to 1.0 (perfect match). */
  score: number;

  /** The judge's explanation of its scoring decision. */
  reasoning: string;

  /** The metric evaluated (e.g., "answer_relevancy", "faithfulness", "logical_coherence"). */
  metric: string;
}
