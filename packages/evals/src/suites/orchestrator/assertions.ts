/**
 * Orchestrator Suite — Custom Assertions
 *
 * Orchestrator-specific assertion logic beyond the generic
 * zod structural and semantic checks.
 *
 * @module suites/orchestrator/assertions
 */

import type { SuiteTestCase } from '../loader.js';
import type { GoldenTrajectory } from '../../dataset/types.js';

/**
 * Builds promptfoo assertion definitions for an orchestrator trajectory.
 *
 * Maps golden trajectory expectations to promptfoo assertion types:
 * - Tool call trajectories get `llm-rubric` assertions for semantic eval
 * - Text output trajectories get `similar` assertions for content matching
 */
export function buildAssertions(
  trajectory: GoldenTrajectory,
): SuiteTestCase['assert'] {
  const assertions: NonNullable<SuiteTestCase['assert']> = [];

  // Semantic similarity on expected output
  if (typeof trajectory.expectedOutput === 'string') {
    assertions.push({
      type: 'llm-rubric',
      value: `The output should convey the same meaning as: "${trajectory.expectedOutput}". Score 1.0 for equivalent meaning, 0.5 for partial match, 0.0 for completely different.`,
    });
  }

  // Tool call assertions — check that the right tools were invoked
  if (trajectory.expectedToolCalls && trajectory.expectedToolCalls.length > 0) {
    for (const toolCall of trajectory.expectedToolCalls) {
      assertions.push({
        type: 'llm-rubric',
        value: `The agent should have called the "${toolCall.toolName}" tool with arguments that include keys: ${Object.keys(toolCall.args).join(', ')}. The exact values may differ but the structure should match.`,
      });
    }
  }

  // Empty tool calls means assert no tools were used
  if (trajectory.expectedToolCalls && trajectory.expectedToolCalls.length === 0) {
    assertions.push({
      type: 'llm-rubric',
      value: 'The agent should have answered directly without making any tool calls.',
    });
  }

  return assertions;
}
