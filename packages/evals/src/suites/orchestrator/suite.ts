/**
 * Orchestrator Eval Suite
 *
 * Active regression suite testing agent trajectory fidelity
 * against golden trajectories from the orchestrator package.
 *
 * Tests cover:
 * - Supervisor routing decisions
 * - Agent tool selection (save_to_memory, MCP tools)
 * - Multi-turn trajectory coherence
 * - Direct-answer cases (no tool calls expected)
 *
 * @module suites/orchestrator/suite
 */

import { loadGoldenTrajectories } from '../../dataset/loader.js';
import { buildAssertions } from './assertions.js';
import {
  SUPERVISOR_ROUTING_PROMPT,
  TOOL_SELECTION_PROMPT,
  MEMORY_SAVE_PROMPT,
  TRAJECTORY_COHERENCE_PROMPT,
} from './prompts.js';
import type { EvalProvider } from '../../providers/types.js';
import type { SuiteConfig, SuiteTestCase } from '../loader.js';

/**
 * Builds the orchestrator eval suite from golden trajectories.
 *
 * Each golden trajectory becomes a promptfoo test case with:
 * - Variables populated from the trajectory's input/output/tool calls
 * - Assertions built from expected tool calls and output
 */
export async function buildSuite(_provider: EvalProvider): Promise<SuiteConfig> {
  let trajectories;
  try {
    trajectories = loadGoldenTrajectories('orchestrator');
  } catch {
    // No golden data yet — return empty suite
    return {
      name: 'orchestrator',
      prompts: [TOOL_SELECTION_PROMPT],
      tests: [],
    };
  }

  const tests: SuiteTestCase[] = trajectories.map(trajectory => {
    const hasToolCalls = trajectory.expectedToolCalls && trajectory.expectedToolCalls.length > 0;
    const expectedOutput = typeof trajectory.expectedOutput === 'string'
      ? trajectory.expectedOutput
      : JSON.stringify(trajectory.expectedOutput);

    const vars: Record<string, string> = {
      task: trajectory.input,
      expected_output: expectedOutput,
    };

    // Populate tool-specific variables
    if (hasToolCalls) {
      const firstTool = trajectory.expectedToolCalls![0];
      vars['expected_tool_name'] = firstTool.toolName;
      vars['expected_tool_args'] = JSON.stringify(firstTool.args);
      vars['actual_tool_name'] = '{{actual_tool_name}}';
      vars['actual_tool_args'] = '{{actual_tool_args}}';
    }

    // Populate supervisor-specific variables for routing tests
    if (trajectory.tags?.includes('supervisor')) {
      vars['managed_nodes'] = 'research, write, edit';
      vars['goal'] = trajectory.input;
      vars['completed_work'] = 'None yet — this is the first routing decision.';
      vars['expected_next_node'] = trajectory.expectedToolCalls?.[0]?.args['agent'] as string ?? 'unknown';
      vars['actual_next_node'] = '{{actual_next_node}}';
      vars['actual_reasoning'] = '{{actual_reasoning}}';
    }

    return {
      description: trajectory.description,
      vars,
      assert: buildAssertions(trajectory),
    };
  });

  // Select prompt templates based on trajectory types
  const prompts: string[] = [];
  const tags = new Set(trajectories.flatMap(t => t.tags ?? []));

  if (tags.has('supervisor')) prompts.push(SUPERVISOR_ROUTING_PROMPT);
  if (tags.has('tool-selection') || tags.has('web-search')) prompts.push(TOOL_SELECTION_PROMPT);
  if (tags.has('no-tools')) prompts.push(TRAJECTORY_COHERENCE_PROMPT);

  // Fallback: always include at least the tool selection prompt
  if (prompts.length === 0) prompts.push(TOOL_SELECTION_PROMPT);

  return {
    name: 'orchestrator',
    prompts,
    tests,
  };
}
