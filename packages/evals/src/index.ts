/**
 * @mcai/evals — Public API
 *
 * Automated eval harness and quality-assurance gatekeeper for
 * @mcai/* packages. Re-exports all public types and schemas.
 *
 * @packageDocumentation
 */

// ─── Dataset Schemas ───────────────────────────────────────────────

export {
  ToolCallSchema,
  SuiteNameSchema,
  TrajectorySourceSchema,
  GoldenTrajectorySchema,
  ManifestEntrySchema,
  ManifestSchema,
} from './dataset/schema.js';

// ─── Dataset Types ─────────────────────────────────────────────────

export type {
  ToolCall,
  GoldenTrajectory,
  SuiteName,
  TrajectorySource,
  ManifestEntry,
  Manifest,
} from './dataset/types.js';

// ─── Dataset Loader ────────────────────────────────────────────────

export {
  loadManifest,
  loadGoldenTrajectories,
  listAvailableSuites,
} from './dataset/loader.js';

// ─── Dataset Writer ────────────────────────────────────────────────

export {
  createSqliteBuffer,
  writeGoldenDataset,
} from './dataset/writer.js';

// ─── Dataset Migration ─────────────────────────────────────────────

export { applyMigrations } from './dataset/migration.js';
export type {
  ParamRename,
  ParamRemove,
  ParamAddRequired,
  MigrationTransform,
  MigrationResult,
} from './dataset/migration.js';

// ─── Runner Types ──────────────────────────────────────────────────

export type {
  EvalMode,
  EvalRunConfig,
  SuiteDriftSummary,
  DriftReport,
  EvalResult,
} from './runner/types.js';

// ─── Assertion Types ───────────────────────────────────────────────

export type {
  TypeMismatch,
  ZodStructuralResult,
  SemanticJudgeResult,
} from './assertions/types.js';

// ─── Zod Structural Assertions ─────────────────────────────────────

export {
  assertToolCallStructure,
  assertTrajectoryStructure,
} from './assertions/zod-structural.js';

// ─── Deterministic Assertions ─────────────────────────────────────

export type { DeterministicResult } from './assertions/deterministic.js';

export {
  assertGreaterThanOrEqual,
  assertLessThanOrEqual,
  assertContainsAllKeys,
  assertSetEquals,
  assertStable,
  assertEqual,
} from './assertions/deterministic.js';

// ─── Calibration Data ─────────────────────────────────────────────

export {
  ANSWER_RELEVANCY_CALIBRATION,
  FAITHFULNESS_CALIBRATION,
  LOGICAL_COHERENCE_CALIBRATION,
  getCalibrationSet,
} from './assertions/calibration-data.js';

// ─── Semantic Judge ────────────────────────────────────────────────

export {
  evaluateMetric,
  evaluateSemantics,
  parseJudgeResponse,
  calibrateJudge,
  ANSWER_RELEVANCY,
  FAITHFULNESS,
  LOGICAL_COHERENCE,
  BUILT_IN_METRICS,
} from './assertions/semantic-judge.js';
export type {
  RubricMetric,
  SemanticJudgeContext,
  SemanticJudgeOptions,
  CalibrationExample,
  CalibrationResult,
} from './assertions/semantic-judge.js';

// ─── Reference-Free Metrics ──────────────────────────────────────

export {
  INSTRUCTION_FOLLOWING,
  OUTPUT_QUALITY,
  SAFETY,
  REFERENCE_FREE_METRICS,
} from './assertions/reference-free-judge.js';

// ─── Drift Calculator ──────────────────────────────────────────────

export { computeDrift } from './assertions/drift-calculator.js';
export type { TestCaseResults } from './assertions/drift-calculator.js';

// ─── Provider Types ────────────────────────────────────────────────

export type {
  CostEstimate,
  EvalProvider,
} from './providers/types.js';

// ─── Providers ─────────────────────────────────────────────────────

export { createOllamaProvider } from './providers/ollama.js';
export type { OllamaProviderOptions } from './providers/ollama.js';
export { createOpenAIProvider } from './providers/openai.js';
export type { OpenAIProviderOptions } from './providers/openai.js';

// ─── Suite Loader ──────────────────────────────────────────────────

export { loadSuite, loadSuites } from './suites/loader.js';
export type { SuiteModule, SuiteConfig, SuiteTestCase } from './suites/loader.js';

// ─── Runner ────────────────────────────────────────────────────────

export { runEvals } from './runner/runner.js';
export { formatReport } from './runner/reporter.js';
export type { ReportOutput } from './runner/reporter.js';
