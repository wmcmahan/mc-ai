/**
 * Orchestrator Eval Suite
 *
 * Regression suite testing agent trajectory fidelity against golden
 * trajectories from `@cycgraph/orchestrator`. Each trajectory drives the
 * real `GraphRunner` via `runSutDispatch`, and the judge grades the
 * agent's actual output against the recorded golden.
 *
 * @module suites/orchestrator/suite
 */

import { loadGoldenTrajectories } from '../../dataset/loader.js';
import {
  ANSWER_RELEVANCY,
  FAITHFULNESS,
} from '../../assertions/semantic-judge.js';
import type { SutSuiteConfig } from '../sut-contract.js';

/**
 * Build the SUT-driven semantic suite for orchestrator.
 *
 * Each trajectory runs through `runOrchestratorSut` against a real LLM
 * (`ANTHROPIC_API_KEY` required at gate time — failures surface as
 * `sut_dispatch` results). The judge then evaluates the agent's actual
 * output against the recorded golden via two complementary metrics:
 *
 *   - `FAITHFULNESS` — does the produced text say the same thing as the
 *     recorded golden?
 *   - `ANSWER_RELEVANCY` — did the agent address the task at all?
 *
 * Structural assertions on observed tool calls are enabled for any
 * trajectory whose golden declares `expectedToolCalls`. Trajectories
 * with `expectedToolCalls: []` (asserting "no tools") fall back to
 * the structural track too — the equality check in
 * `assertTrajectoryStructure` handles the empty-array case.
 */
export async function buildSutSuite(): Promise<SutSuiteConfig> {
  const trajectories = loadGoldenTrajectories('orchestrator');
  return {
    name: 'orchestrator',
    tests: trajectories.map(t => ({
      trajectoryId: t.id,
      description: t.description,
      metrics: [
        { metric: ANSWER_RELEVANCY },
        { metric: FAITHFULNESS },
      ],
      // Structural assertions matter whenever the golden defines tool-call
      // expectations — including the "no tools" assertion (empty array).
      structuralAssertions: t.expectedToolCalls !== undefined,
    })),
  };
}
