/**
 * Memory Suite — Semantic Assertions
 *
 * Builds LLM-as-judge assertions for the semantic eval track.
 * These check whether retrieved memory helps produce accurate answers.
 *
 * @module suites/memory/assertions
 */

import type { SuiteTestCase } from '../loader.js';

/**
 * Build promptfoo assertions for a given test type.
 */
export function buildAssertions(
  testType: 'memory-qa' | 'temporal-reasoning',
): SuiteTestCase['assert'] {
  switch (testType) {
    case 'memory-qa':
      return [{
        type: 'llm-rubric',
        value: 'The response should answer the question correctly using the provided memory context. '
          + 'Expected answer: "{{expected_answer}}". '
          + 'Score 1.0 if factually correct, 0.5 for partially correct, 0.0 for wrong.',
      }];

    case 'temporal-reasoning':
      return [{
        type: 'llm-rubric',
        value: 'The response should correctly reason about temporal validity. '
          + 'Only facts valid as of the specified date should be used. '
          + 'Expected answer: "{{expected_answer}}". '
          + 'Score 1.0 if temporally correct, 0.5 if correct answer but no temporal reasoning, 0.0 for wrong.',
      }];
  }
}
