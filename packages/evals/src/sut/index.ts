/**
 * SUT (System-Under-Test) — Barrel Export
 *
 * Public surface for the recording layer. Used by `scripts/record-goldens.ts`
 * and external consumers who want to capture observable behavior from
 * `@cycgraph/*` packages.
 *
 * @module sut
 */

export type {
  RecordedToolCall,
  SutStatus,
  SutRunResult,
  ToolResponseFn,
  ToolResponseMap,
} from './types.js';

export { createMockToolResolver } from './mock-tool-resolver.js';

export {
  runOrchestratorSut,
  extractOutput,
} from './orchestrator-sut.js';
export type { RunOrchestratorSutOptions } from './orchestrator-sut.js';

export {
  buildSingleAgentGraph,
} from './graphs/single-agent.js';
export type {
  SingleAgentGraphOptions,
  SingleAgentGraphArtifacts,
} from './graphs/single-agent.js';

export { buildSupervisorGraph } from './graphs/supervisor.js';
export type {
  SupervisorGraphOptions,
  SupervisorGraphArtifacts,
} from './graphs/supervisor.js';

export { buildBranchingGraph } from './graphs/branching.js';
export type {
  BranchingGraphOptions,
  BranchingGraphArtifacts,
} from './graphs/branching.js';

export { buildRetryGraph } from './graphs/retry.js';
export type {
  RetryGraphOptions,
  RetryGraphArtifacts,
} from './graphs/retry.js';

export {
  createFlakyFetch,
  createRateLimitedCall,
} from './fixtures/retry-tools.js';
export type {
  FlakyFetchOptions,
  RateLimitedOptions,
} from './fixtures/retry-tools.js';

export { runSutDispatch } from './dispatch.js';
export type { SutDispatchOptions } from './dispatch.js';

export {
  runMemorySut,
  getSupportedMemoryHandlers,
  isMemoryTrajectorySupported,
} from './memory-sut.js';
export type { RunMemorySutOptions } from './memory-sut.js';

export {
  runContextEngineSut,
  getSupportedContextEngineHandlers,
  isContextEngineTrajectorySupported,
} from './context-engine-sut.js';
export type { RunContextEngineSutOptions } from './context-engine-sut.js';
