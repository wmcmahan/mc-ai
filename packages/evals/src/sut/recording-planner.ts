/**
 * Recording Planner
 *
 * Decides, for a given trajectory, which SUT path to run and which tool
 * fixtures to inject. Extracted from `scripts/record-goldens.ts` so the
 * dispatch logic is unit-testable without invoking real LLMs or library
 * pipelines.
 *
 * The planner is pure: same `(suite, trajectory)` → same `RecordingPlan`.
 * Stateful fixture construction (closures over counters) happens later,
 * inside the recording script's per-sample dispatcher.
 *
 * @module sut/recording-planner
 */

import {
  isMemoryTrajectorySupported,
} from './memory-sut.js';
import {
  isContextEngineTrajectorySupported,
} from './context-engine-sut.js';
import type { GoldenTrajectory, SuiteName } from '../dataset/types.js';

/** Orchestrator graph topologies the recording planner can dispatch to. */
export type OrchestratorGraphKind =
  | 'single-agent'
  | 'supervisor'
  | 'branching'
  | 'retry';

/** Tool fixture profile resolved to fresh fixtures per sample. */
export type OrchestratorToolKind =
  | 'none'
  | 'web_search'
  | 'flaky_fetch'
  | 'rate_limited_call';

/** Plan for recording a single trajectory. */
export interface RecordingPlan {
  /** Trajectory under recording. */
  trajectory: GoldenTrajectory;
  /** Whether this trajectory is supported by the current SUT set. */
  supported: boolean;
  /** Skip reason when unsupported. */
  skipReason?: string;
  /** Which reference graph to build (orchestrator only). */
  graphKind?: OrchestratorGraphKind;
  /** Which tool fixture profile to use (orchestrator only). */
  toolKind?: OrchestratorToolKind;
}

function planOrchestratorTrajectory(trajectory: GoldenTrajectory): RecordingPlan {
  const tags = new Set(trajectory.tags ?? []);

  if (tags.has('supervisor') || tags.has('multi-agent') || tags.has('delegation')) {
    return { trajectory, supported: true, graphKind: 'supervisor', toolKind: 'none' };
  }

  if (tags.has('branching') || tags.has('conditional')) {
    return { trajectory, supported: true, graphKind: 'branching', toolKind: 'none' };
  }

  if (tags.has('error') || tags.has('retry')) {
    const isRateLimited = trajectory.description.toLowerCase().includes('rate limit');
    return {
      trajectory,
      supported: true,
      graphKind: 'retry',
      toolKind: isRateLimited ? 'rate_limited_call' : 'flaky_fetch',
    };
  }

  if (
    tags.has('linear') ||
    tags.has('basic') ||
    tags.has('no-tools') ||
    tags.has('budget') ||
    tags.has('limits') ||
    tags.has('state') ||
    tags.has('persistence')
  ) {
    return {
      trajectory,
      supported: true,
      graphKind: 'single-agent',
      toolKind: tags.has('no-tools') ? 'none' : 'web_search',
    };
  }

  return {
    trajectory,
    supported: false,
    skipReason: `No reference graph for tags [${[...tags].join(', ')}] yet`,
  };
}

function planMemoryTrajectory(trajectory: GoldenTrajectory): RecordingPlan {
  if (isMemoryTrajectorySupported(trajectory)) {
    return { trajectory, supported: true };
  }
  const tags = trajectory.tags ?? [];
  return {
    trajectory,
    supported: false,
    skipReason: `No memory handler for tags [${tags.join(', ')}] yet`,
  };
}

function planContextEngineTrajectory(trajectory: GoldenTrajectory): RecordingPlan {
  if (isContextEngineTrajectorySupported(trajectory)) {
    return { trajectory, supported: true };
  }
  const tags = trajectory.tags ?? [];
  return {
    trajectory,
    supported: false,
    skipReason: `No context-engine handler for tags [${tags.join(', ')}] yet`,
  };
}

/**
 * Produce a recording plan for one trajectory.
 *
 * Returned plan describes what the recording script will do; it does not
 * yet allocate any tool fixtures (those are resolved per-sample to keep
 * stateful closures isolated).
 */
export function planForTrajectory(
  suite: SuiteName,
  trajectory: GoldenTrajectory,
): RecordingPlan {
  switch (suite) {
    case 'orchestrator':
      return planOrchestratorTrajectory(trajectory);
    case 'memory':
      return planMemoryTrajectory(trajectory);
    case 'context-engine':
      return planContextEngineTrajectory(trajectory);
    case 'integration':
      return {
        trajectory,
        supported: false,
        skipReason: 'integration suite has no goldens to record',
      };
  }
}

/** Plan an entire suite at once. Useful for dry-run classification reports. */
export function planSuite(
  suite: SuiteName,
  trajectories: GoldenTrajectory[],
): RecordingPlan[] {
  return trajectories.map(t => planForTrajectory(suite, t));
}
