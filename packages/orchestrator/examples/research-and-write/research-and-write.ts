/**
 * Research & Write — Runnable Example
 *
 * A 2-node linear workflow: a Researcher agent gathers notes,
 * then a Writer agent produces a polished draft.
 *
 * Demonstrates: agent-as-config, zero-trust state slicing,
 * graph definition, in-memory persistence, and event listeners.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts
 */

import { v4 as uuidv4 } from 'uuid';
import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
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
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Register agents ──────────────────────────────────────────────────
// Agent IDs must be UUIDs (the factory validates this before registry lookup).

const RESEARCHER_ID = uuidv4();
const WRITER_ID = uuidv4();

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
  description: 'Produces a polished draft from research notes',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a professional writer.',
    'Using the provided research notes, produce a clear and engaging summary.',
    'Keep it under 300 words. Use plain language.',
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

const registry = new InMemoryAgentRegistry();
registry.register(researcher);
registry.register(writer);
configureAgentFactory(registry);

// Configure LLM providers — built-in OpenAI + Anthropic are pre-registered.
// Add custom providers here (e.g., Groq, Ollama) via providers.register().
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────

const now = new Date();

const graph: Graph = {
  id: uuidv4(),
  name: 'Research & Write',
  description: 'Two-node linear workflow: research then write',
  version: '1.0.0',
  created_at: now,
  updated_at: now,

  nodes: [
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
  ],

  edges: [
    {
      id: 'research-to-write',
      source: 'research',
      target: 'write',
      condition: { type: 'always' },
    },
  ],

  start_node: 'research',
  end_nodes: ['write'],
};

// ─── 3. Create initial state ─────────────────────────────────────────────

const initialState: WorkflowState = {
  workflow_id: graph.id,
  run_id: uuidv4(),
  created_at: now,
  updated_at: now,
  goal: 'Explain how large language models work, including transformers, attention mechanisms, and training data.',
  constraints: ['Keep the final draft under 300 words', 'Use plain language suitable for a general audience'],
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
  max_execution_time_ms: 120_000,
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
  logger.info('Starting research-and-write workflow...\n');

  try {
    const finalState = await runner.run();

    if (finalState.status === 'completed') {
      console.log('\n═══ Research Notes ═══');
      console.log(finalState.memory.research_notes ?? '(none)');
      console.log('\n═══ Final Draft ═══');
      console.log(finalState.memory.draft ?? '(none)');
      console.log('\n═══ Stats ═══');
      console.log(`  Tokens used: ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):  $${finalState.total_cost_usd.toFixed(4)}`);
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
