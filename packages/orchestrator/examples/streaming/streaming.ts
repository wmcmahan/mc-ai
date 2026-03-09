/**
 * Streaming — Runnable Example
 *
 * A 2-node linear workflow consumed via `stream()` instead of `run()`.
 * Demonstrates real-time event handling including token-by-token output,
 * typed event discrimination, and the `isTerminalEvent()` type guard.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/streaming/streaming.ts
 */

import { v4 as uuidv4 } from 'uuid';
import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  ProviderRegistry,
  registerBuiltInProviders,
  configureProviderRegistry,
  isTerminalEvent,
  type Graph,
  type WorkflowState,
  type StreamEvent,
  type AgentRegistryEntry,
} from '@mcai/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/streaming/streaming.ts');
  process.exit(1);
}

// ─── 1. Register agents ──────────────────────────────────────────────────

const RESEARCHER_ID = uuidv4();
const WRITER_ID = uuidv4();

const registry = new InMemoryAgentRegistry();

registry.register({
  id: RESEARCHER_ID,
  name: 'Research Agent',
  description: 'Gathers background information on a topic',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a research specialist.',
    'Given a goal, produce concise, factual research notes as bullet points.',
    'You MUST save your output by calling save_to_memory with key "research_notes".',
  ].join(' '),
  temperature: 0.5,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'constraints'],
    write_keys: ['research_notes'],
  },
});

registry.register({
  id: WRITER_ID,
  name: 'Writer Agent',
  description: 'Produces a polished draft from research notes',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a professional writer.',
    'Using the provided research notes, produce a clear and engaging summary under 200 words.',
    'You MUST save your output by calling save_to_memory with key "draft".',
  ].join(' '),
  temperature: 0.7,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'research_notes'],
    write_keys: ['draft'],
  },
});

configureAgentFactory(registry);

// Configure LLM providers — built-in OpenAI + Anthropic are pre-registered.
// Add custom providers here (e.g., Groq, Ollama) via providers.register().
const providers = new ProviderRegistry();
registerBuiltInProviders(providers);
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────

const now = new Date();

const graph: Graph = {
  id: uuidv4(),
  name: 'Streaming Research & Write',
  description: 'Two-node linear workflow with streaming output',
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
    { id: 'research-to-write', source: 'research', target: 'write', condition: { type: 'always' } },
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
  goal: 'Explain how large language models work, covering transformers and attention.',
  constraints: ['Keep under 200 words', 'Use plain language'],
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

// ─── 4. Stream execution ─────────────────────────────────────────────────

async function main() {
  const persistence = new InMemoryPersistenceProvider();

  const runner = new GraphRunner(graph, initialState, {
    persistStateFn: async (state) => {
      await persistence.saveWorkflowState(state);
    },
  });

  console.log('Starting streaming workflow...\n');

  let currentNode = '';

  for await (const event of runner.stream()) {
    switch (event.type) {
      case 'workflow:start':
        console.log(`[workflow:start] run_id=${event.run_id}\n`);
        break;

      case 'node:start':
        currentNode = event.node_id;
        console.log(`\n[node:start] ${event.node_id} (${event.node_type})`);
        break;

      case 'agent:token_delta':
        // Real-time token streaming — write each token as it arrives
        process.stdout.write(event.token);
        break;

      case 'node:complete':
        console.log(`\n[node:complete] ${event.node_id} (${event.duration_ms}ms)`);
        break;

      case 'action:applied':
        console.log(`[action:applied] ${event.action_type} on ${event.node_id}`);
        break;

      case 'state:persisted':
        console.log(`[state:persisted] iteration=${event.iteration}`);
        break;

      case 'node:retry':
        console.log(`[node:retry] ${event.node_id} attempt=${event.attempt} backoff=${event.backoff_ms}ms`);
        break;

      case 'budget:threshold_reached':
        console.log(`[budget] ${event.threshold_pct}% of $${event.budget_usd} used`);
        break;
    }

    // Use the type guard to detect terminal events
    if (isTerminalEvent(event)) {
      console.log(`\n[${event.type}] Final status: ${event.state.status}`);

      if (event.type === 'workflow:complete') {
        console.log('\n═══ Research Notes ═══');
        console.log(event.state.memory.research_notes ?? '(none)');
        console.log('\n═══ Final Draft ═══');
        console.log(event.state.memory.draft ?? '(none)');
        console.log('\n═══ Stats ═══');
        console.log(`  Tokens used: ${event.state.total_tokens_used}`);
        console.log(`  Cost (USD):  $${event.state.total_cost_usd.toFixed(4)}`);
      } else if (event.type === 'workflow:failed') {
        console.error(`Error: ${event.error}`);
        process.exit(1);
      }
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
