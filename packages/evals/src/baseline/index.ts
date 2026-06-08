/**
 * Baseline — Barrel Export
 *
 * Public surface for the baseline persistence + comparison subsystem.
 * Consumers should import from `@cycgraph/evals/baseline` rather than
 * reaching into individual modules.
 *
 * @module baseline
 */

export type {
  BaselineSnapshot,
  BaselineSuiteEntry,
  BaselineDelta,
  SuiteDelta,
} from './types.js';
export { BASELINE_SCHEMA_VERSION } from './types.js';

export { snapshotFromDrift } from './snapshot.js';
export type { SnapshotInput } from './snapshot.js';

export { writeBaseline } from './writer.js';
export type { WriteBaselineResult } from './writer.js';

export { loadBaseline } from './loader.js';

export { compareBaseline, formatBaselineDelta } from './compare.js';
export type { CompareBaselineOptions } from './compare.js';
