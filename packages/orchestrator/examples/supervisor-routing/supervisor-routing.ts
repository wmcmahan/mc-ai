/**
 * Supervisor Routing — Runnable Example
 *
 * A 4-node cyclic hub-and-spoke workflow: a Supervisor agent dynamically
 * routes work between Research, Write, and Edit specialist agents.
 *
 * Demonstrates: supervisor pattern, LLM-powered dynamic routing,
 * cyclic graphs, hub-and-spoke topology, and the __done__ sentinel.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts
 */

import { v4 as uuidv4 } from 'uuid';
import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  ProviderRegistry,
  createProviderRegistry,
  configureProviderRegistry,
  createLogger,
  type Graph,
  type WorkflowState,
  type AgentRegistryEntry,
} from '@mcai/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Register agents ──────────────────────────────────────────────────
// Agent IDs must be UUIDs (the factory validates this before registry lookup).

const SUPERVISOR_ID = uuidv4();
const RESEARCHER_ID = uuidv4();
const WRITER_ID = uuidv4();
const EDITOR_ID = uuidv4();

const supervisor: AgentRegistryEntry = {
  id: SUPERVISOR_ID,
  name: 'Supervisor Agent',
  description: 'Routes tasks between specialist agents to produce a polished article',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a project supervisor coordinating a team of specialists to produce a high-quality article.',
    'You have three team members: "research" (gathers facts), "write" (produces drafts), and "edit" (polishes prose).',
    'Review the current state and decide which specialist should work next.',
    'Typical flow: research → write → edit, but you may loop back if quality is insufficient.',
    'When the final_draft is polished and ready, route to "__done__" to complete the workflow.',
  ].join(' '),
  temperature: 0.3,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['*'],
    write_keys: ['*'],
  },
};

const researcher: AgentRegistryEntry = {
  id: RESEARCHER_ID,
  name: 'Research Agent',
  description: 'Gathers background information on a topic',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a research specialist.',
    'Given a goal, produce concise, factual research notes.',
    'Focus on key facts, statistics, and notable perspectives.',
    'Write your findings as bullet points.',
    'You MUST save your output by calling save_to_memory with key "research_notes".',
  ].join(' '),
  temperature: 0.5,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'constraints'],
    write_keys: ['research_notes'],
  },
};

const writer: AgentRegistryEntry = {
  id: WRITER_ID,
  name: 'Writer Agent',
  description: 'Produces a draft article from research notes',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a professional writer.',
    'Using the provided research notes, produce a clear and engaging article draft.',
    'Keep it under 500 words. Use plain language.',
    'You MUST save your output by calling save_to_memory with key "draft".',
  ].join(' '),
  temperature: 0.7,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'research_notes'],
    write_keys: ['draft'],
  },
};

const editor: AgentRegistryEntry = {
  id: EDITOR_ID,
  name: 'Editor Agent',
  description: 'Polishes a draft into a final article',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a meticulous editor.',
    'Review the draft for clarity, grammar, flow, and factual accuracy.',
    'Produce a polished final version.',
    'You MUST save your output by calling save_to_memory with key "final_draft".',
  ].join(' '),
  temperature: 0.4,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'draft'],
    write_keys: ['final_draft'],
  },
};

const registry = new InMemoryAgentRegistry();
registry.register(supervisor);
registry.register(researcher);
registry.register(writer);
registry.register(editor);
configureAgentFactory(registry);

// Configure LLM providers — built-in OpenAI + Anthropic are pre-registered.
// Add custom providers here (e.g., Groq, Ollama) via providers.register().
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────
// Cyclic hub-and-spoke: supervisor ⇄ research, supervisor ⇄ write, supervisor ⇄ edit.
// The supervisor routes dynamically; termination is via the __done__ sentinel.

const now = new Date();

const graph: Graph = {
  id: uuidv4(),
  name: 'Supervisor Routing',
  description: 'Cyclic hub-and-spoke workflow with LLM-powered dynamic routing',
  version: '1.0.0',
  created_at: now,
  updated_at: now,

  nodes: [
    {
      id: 'supervisor',
      type: 'supervisor',
      agent_id: SUPERVISOR_ID,
      read_keys: ['*'],
      write_keys: ['*'],
      supervisor_config: {
        agent_id: SUPERVISOR_ID,
        managed_nodes: ['research', 'write', 'edit'],
        max_iterations: 10,
      },
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'research',
      type: 'agent',
      agent_id: RESEARCHER_ID,
      read_keys: ['goal', 'constraints'],
      write_keys: ['research_notes'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'write',
      type: 'agent',
      agent_id: WRITER_ID,
      read_keys: ['goal', 'research_notes'],
      write_keys: ['draft'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'edit',
      type: 'agent',
      agent_id: EDITOR_ID,
      read_keys: ['goal', 'draft'],
      write_keys: ['final_draft'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
  ],

  edges: [
    // Supervisor → specialists (outbound)
    { id: 'supervisor-to-research', source: 'supervisor', target: 'research', condition: { type: 'always' } },
    { id: 'supervisor-to-write', source: 'supervisor', target: 'write', condition: { type: 'always' } },
    { id: 'supervisor-to-edit', source: 'supervisor', target: 'edit', condition: { type: 'always' } },
    // Specialists → supervisor (return)
    { id: 'research-to-supervisor', source: 'research', target: 'supervisor', condition: { type: 'always' } },
    { id: 'write-to-supervisor', source: 'write', target: 'supervisor', condition: { type: 'always' } },
    { id: 'edit-to-supervisor', source: 'edit', target: 'supervisor', condition: { type: 'always' } },
  ],

  start_node: 'supervisor',
  end_nodes: [],  // Termination via __done__ sentinel
};

// ─── 3. Create initial state ─────────────────────────────────────────────

const initialState: WorkflowState = {
  workflow_id: graph.id,
  run_id: uuidv4(),
  created_at: now,
  updated_at: now,
  goal: 'Write a concise article about how renewable energy is transforming the global power grid, covering solar, wind, and battery storage.',
  constraints: ['Keep the final article under 500 words', 'Use plain language suitable for a general audience'],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  total_tokens_used: 0,
  total_cost_usd: 0,
  _cost_alert_thresholds_fired: [],
  visited_nodes: [],
  max_iterations: 50,
  compensation_stack: [],
  supervisor_history: [],
  max_execution_time_ms: 300_000,
};

// ─── 4. Set up persistence + runner ──────────────────────────────────────

const persistence = new InMemoryPersistenceProvider();

const runner = new GraphRunner(graph, initialState, {
  persistStateFn: async (state) => {
    await persistence.saveWorkflowState(state);
    await persistence.saveWorkflowRun(state);
  },
});

// Event listeners for observability
runner.on('workflow:start', ({ run_id }) => {
  logger.info(`Workflow started: ${run_id}`);
});

runner.on('node:start', ({ node_id, type }) => {
  logger.info(`  Node started: ${node_id} (${type})`);
});

runner.on('node:complete', ({ node_id, duration_ms }) => {
  logger.info(`  Node complete: ${node_id} (${duration_ms}ms)`);
});

runner.on('workflow:complete', ({ run_id, duration_ms }) => {
  logger.info(`Workflow complete: ${run_id} (${duration_ms}ms)`);
});

runner.on('workflow:failed', ({ run_id, error }) => {
  logger.error(`Workflow failed: ${run_id} — ${error}`);
});

// ─── 5. Run ──────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting supervisor-routing workflow...\n');

  try {
    const finalState = await runner.run();

    if (finalState.status === 'completed') {
      console.log('\n═══ Supervisor Routing History ═══');
      for (const entry of finalState.supervisor_history) {
        console.log(`  [iter ${entry.iteration}] → ${entry.delegated_to} (${entry.reasoning})`);
      }
      console.log('  → __done__ (workflow completed)');

      console.log('\n═══ Research Notes ═══');
      console.log(finalState.memory.research_notes ?? '(none)');
      console.log('\n═══ Draft ═══');
      console.log(finalState.memory.draft ?? '(none)');
      console.log('\n═══ Final Draft ═══');
      console.log(finalState.memory.final_draft ?? '(none)');
      console.log('\n═══ Stats ═══');
      console.log(`  Nodes visited:  ${finalState.visited_nodes.join(' → ')}`);
      console.log(`  Tokens used:    ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):     $${finalState.total_cost_usd.toFixed(4)}`);
    } else {
      console.error(`Workflow ended with status: ${finalState.status}`);
      if (finalState.last_error) {
        console.error(`Error: ${finalState.last_error}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
