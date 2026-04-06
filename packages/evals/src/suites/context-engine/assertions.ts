/**
 * Context Engine Suite — Semantic Assertions
 *
 * Builds LLM-as-judge assertions for the semantic eval track.
 * These check whether compressed context produces semantically
 * equivalent LLM responses compared to uncompressed originals.
 *
 * @module suites/context-engine/assertions
 */

import type { SuiteTestCase } from '../loader.js';

/**
 * Build promptfoo assertions for a given test type.
 *
 * @param testType - The type of semantic test.
 * @returns Array of assertion definitions for promptfoo.
 */
export function buildAssertions(
  testType: 'compression-equivalence' | 'information-extraction',
): SuiteTestCase['assert'] {
  switch (testType) {
    case 'compression-equivalence':
      return [{
        type: 'llm-rubric',
        value: 'The response should convey the same factual answer as: "{{expected_answer}}". '
          + 'Score 1.0 if the answer matches semantically, 0.5 for partial match, 0.0 for wrong answer. '
          + 'The format may differ but the facts must be equivalent.',
      }];

    case 'information-extraction':
      return [{
        type: 'llm-rubric',
        value: 'The response should extract the correct specific values from the compressed data. '
          + 'Expected answer: "{{expected_answer}}". '
          + 'Score 1.0 if all values are correct, 0.5 if some are correct, 0.0 if values are wrong or missing.',
      }];
  }
}
