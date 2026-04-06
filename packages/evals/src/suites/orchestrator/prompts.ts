/**
 * Orchestrator Suite — Prompt Templates
 *
 * Frozen prompt templates for orchestrator eval test cases.
 * These prompts are fed to the LLM judge to evaluate whether
 * actual agent behavior matches golden trajectory expectations.
 *
 * @module suites/orchestrator/prompts
 */

/** Evaluates whether a supervisor routing decision is appropriate. */
export const SUPERVISOR_ROUTING_PROMPT = `You are evaluating an AI workflow supervisor's routing decision.

The supervisor manages these worker agents: {{managed_nodes}}

Given the current workflow state:
- Goal: {{goal}}
- Completed work so far: {{completed_work}}

The supervisor decided to route to: {{actual_next_node}}
With reasoning: {{actual_reasoning}}

The expected routing was: {{expected_next_node}}

Does the supervisor's routing decision make sense for achieving the workflow goal? Consider whether the chosen agent is appropriate for the current stage of work, even if it differs from the expected routing.

Respond with ONLY a JSON object: {"score": <0.0-1.0>, "reasoning": "<explanation>"}`;

/** Evaluates whether an agent selected the correct tool for a task. */
export const TOOL_SELECTION_PROMPT = `You are evaluating whether an AI agent selected the appropriate tool for its task.

Task given to the agent: {{task}}

The agent called tool: {{actual_tool_name}}
With arguments: {{actual_tool_args}}

The expected tool was: {{expected_tool_name}}
With expected argument structure: {{expected_tool_args}}

Evaluate whether the agent's tool selection and argument structure are appropriate for the task. The exact argument values may differ — focus on whether the right tool was called with structurally correct arguments.

Respond with ONLY a JSON object: {"score": <0.0-1.0>, "reasoning": "<explanation>"}`;

/** Evaluates whether an agent's save_to_memory output is appropriate. */
export const MEMORY_SAVE_PROMPT = `You are evaluating whether an AI agent saved appropriate data to workflow memory.

Task: {{task}}
Agent saved to key "{{memory_key}}": {{actual_value}}
Expected key: "{{expected_key}}"
Expected value summary: {{expected_value}}

Does the saved data serve the workflow goal? Is the key name appropriate? Does the content quality match expectations?

Respond with ONLY a JSON object: {"score": <0.0-1.0>, "reasoning": "<explanation>"}`;

/** Evaluates a multi-step agent trajectory for logical coherence. */
export const TRAJECTORY_COHERENCE_PROMPT = `You are evaluating a multi-step AI agent trajectory for logical coherence.

Goal: {{goal}}

Steps taken:
{{trajectory_steps}}

Expected trajectory pattern:
{{expected_pattern}}

Evaluate whether the sequence of tool calls forms a logically coherent plan to achieve the goal. Consider: Are the steps in a sensible order? Does each step build on the previous one? Are there unnecessary or redundant steps?

Respond with ONLY a JSON object: {"score": <0.0-1.0>, "reasoning": "<explanation>"}`;
