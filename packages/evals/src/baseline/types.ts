/**
 * Baseline Persistence Types
 *
 * Snapshots and deltas used to track eval quality over time. Each run
 * can persist a `BaselineSnapshot`; subsequent runs compare against the
 * latest snapshot via `BaselineDelta` to detect regressions that the
 * absolute drift ceiling alone would miss.
 *
 * @module baseline/types
 */

/** Schema version for forward compatibility. Bump when the shape changes. */
export const BASELINE_SCHEMA_VERSION = '1';

/** Per-suite breakdown stored in a snapshot. */
export interface BaselineSuiteEntry {
  driftPercent: number;
  totalTests: number;
  zodFailures: number;
  semanticFailures: number;
  deterministicFailures: number;
}

/**
 * A single point-in-time record of eval state. Persisted as JSON under
 * `golden/baselines/`. Subsequent runs load the latest snapshot and
 * compare against it.
 */
export interface BaselineSnapshot {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  /** ISO timestamp the snapshot was captured. */
  generatedAt: string;
  /** Short git SHA at the time of capture, when available. */
  commit?: string;
  /** Run mode (`local` / `ci`) for context. */
  mode?: string;
  /** Drift ceiling that was in effect when the snapshot was taken. */
  driftCeiling: number;
  /** Aggregate drift percentage at snapshot time. */
  aggregateDrift: number;
  /** Whether the snapshot represents a passing run. */
  passed: boolean;
  /** Per-suite snapshot. Keyed by suite name. */
  suites: Record<string, BaselineSuiteEntry>;
}

/** One per-suite regression (or improvement) detected against the baseline. */
export interface SuiteDelta {
  suite: string;
  /** Drift percent in the baseline snapshot. */
  before: number;
  /** Drift percent in the current run. */
  after: number;
  /**
   * Absolute change in drift percent (after - before). Positive values are
   * regressions; negative values are improvements.
   */
  deltaPercent: number;
}

/**
 * Difference between a current run and the prior baseline. Used by the
 * runner to surface regressions that don't trip the absolute gate.
 */
export interface BaselineDelta {
  /** Whether a baseline existed to compare against. */
  hasBaseline: boolean;
  /** Net aggregate-drift change. Positive = worse, negative = better. */
  aggregateDriftDelta: number;
  /** Suites whose drift increased by more than `noiseFloor`. */
  regressions: SuiteDelta[];
  /** Suites whose drift decreased by more than `noiseFloor`. */
  improvements: SuiteDelta[];
  /** Suites present in current but absent from baseline. */
  newSuites: string[];
  /** Suites present in baseline but absent from current. */
  droppedSuites: string[];
  /** Convenience flag — `regressions.length > 0`. */
  hasRegression: boolean;
}
