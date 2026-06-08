/**
 * SUT-Driven Suite Contract
 *
 * A suite declares which trajectories to evaluate and which rubric metrics
 * to apply to each one. No prompt templates, no `actual_*` placeholders —
 * the rubric metric IS the prompt.
 *
 * At gate time, the runner:
 *   1. Loads the suite via `buildSutSuite()`
 *   2. For each test, resolves the linked trajectory from the golden dataset
 *   3. Dispatches the trajectory to its SUT (via `runSutDispatch`)
 *   4. Applies structural assertions to the observed tool calls
 *   5. Applies each declared metric via `evaluateMetricMultiSample`
 *
 * That gives every semantic test a real `actualOutput` — produced by the
 * code at the current commit — instead of a prompt-evaluation result
 * that bypasses the orchestrator entirely.
 *
 * @module suites/sut-contract
 */

import type { RubricMetric } from '../assertions/semantic-judge.js';

/**
 * One rubric metric attached to a test, with an optional per-test
 * threshold override. Defaults to 0.8 when not specified — matching the
 * single-sample `evaluateMetric` behavior.
 */
export interface MetricSpec {
  /** The rubric metric to apply (e.g., `ANSWER_RELEVANCY`). */
  metric: RubricMetric;
  /** Pass threshold (median score). Defaults to 0.8. */
  threshold?: number;
}

/**
 * A single SUT-driven test case. References a trajectory by ID and
 * declares which metrics to apply. No prompt templates — the rubric
 * metric IS the prompt.
 */
export interface SutSuiteTestCase {
  /**
   * Trajectory ID this test evaluates. Must match an entry in the
   * suite's golden dataset; the runner looks it up via
   * `loadGoldenTrajectories(suite).find(t => t.id === trajectoryId)`.
   */
  trajectoryId: string;

  /**
   * Optional human-readable description for the report. Defaults to
   * the trajectory's own description when omitted.
   */
  description?: string;

  /**
   * Rubric metrics to apply. Each one becomes an
   * `evaluateMetricMultiSample` call against the SUT's actual output.
   * An empty array disables semantic evaluation for this test.
   */
  metrics: MetricSpec[];

  /**
   * When true (default), structural assertions are applied to the SUT's
   * observed tool calls against `trajectory.expectedToolCalls`. Skipping
   * this is useful for tests where tool calls are nondeterministic but
   * the output text is still gradeable by a judge.
   */
  structuralAssertions?: boolean;
}

/** Output of `buildSutSuite()`. */
export interface SutSuiteConfig {
  /** Suite name; must match the golden dataset key. */
  name: string;
  /** Test cases. */
  tests: SutSuiteTestCase[];
}

/** The shape each suite module must export to participate in the gate. */
export interface SutSuiteModule {
  /**
   * Build the SUT-driven suite. No provider argument — the runner owns
   * the judge LLM and passes it in at evaluation time.
   */
  buildSutSuite(): Promise<SutSuiteConfig>;
}
