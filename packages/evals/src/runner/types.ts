/**
 * Runner Type Definitions
 *
 * Configuration, result, and reporting types for the eval runner.
 *
 * @module runner/types
 */

import type { SuiteName } from '../dataset/types.js';

// ─── Run Configuration ─────────────────────────────────────────────

/** Execution mode determines which provider and concurrency settings to use. */
export type EvalMode = 'local' | 'ci';

/** Configuration for a single eval run. */
export interface EvalRunConfig {
  /** Execution mode: 'local' (Ollama) or 'ci' (GPT-4o). */
  mode: EvalMode;

  /** Suite names to run. If omitted, all suites are executed. */
  suites?: SuiteName[];

  /** Override the default max concurrency for this run. */
  maxConcurrency?: number;

  /** Override the default Semantic Drift ceiling (default: 5.0). */
  driftCeiling?: number;
}

// ─── Drift Report ──────────────────────────────────────────────────

/** Per-suite drift breakdown. */
export interface SuiteDriftSummary {
  suiteName: string;
  totalTests: number;
  zodFailures: number;
  semanticFailures: number;
  deterministicFailures: number;
  driftPercent: number;
}

/**
 * Aggregate Semantic Drift report across all suites.
 *
 * `aggregatePercent` is the gate metric — if >= driftCeiling (default 5.0),
 * the eval run fails and the PR is blocked.
 */
export interface DriftReport {
  /** Aggregate drift percentage across all suites. */
  aggregatePercent: number;

  /** Per-suite breakdown. */
  perSuite: Record<string, SuiteDriftSummary>;

  /** Whether the run passed the drift ceiling gate. */
  passed: boolean;
}

// ─── Eval Result ───────────────────────────────────────────────────

/**
 * Complete result of an eval run.
 *
 * `raw` is typed as `unknown` until promptfoo is added as a dependency
 * in Phase 4. At that point it will be typed as `EvaluateSummary`.
 */
export interface EvalResult {
  /** Computed drift report with gate pass/fail. */
  drift: DriftReport;

  /** Raw promptfoo evaluation summary. */
  raw: unknown;
}
