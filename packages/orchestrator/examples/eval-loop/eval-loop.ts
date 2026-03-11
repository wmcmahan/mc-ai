/**
 * Eval Loop — Runnable Example
 *
 * A 3-node cyclic workflow: a Writer drafts content, an Evaluator scores it,
 * and either loops back for revision (score < 0.8) or forwards to a Publisher
 * (score >= 0.8).
 *
 * Demonstrates: conditional edges, cyclic graphs, iterative refinement,
 * agent-as-config, in-memory persistence, and event listeners.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/eval-loop/eval-loop.ts
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
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/eval-loop/eval-loop.ts');
  process.exit(1);
}

const logger = createLogger('example');

// ─── 1. Register agents ──────────────────────────────────────────────────

const WRITER_ID = uuidv4();
const EVALUATOR_ID = uuidv4();
const PUBLISHER_ID = uuidv4();

const writerAgent: AgentRegistryEntry = {
  id: WRITER_ID,
  name: 'Writer Agent',
  description: 'Writes or refines a draft based on feedback',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a skilled writer.',
    'Your task: write a concise, engaging explanation of the given topic for a general audience.',
    'If memory.feedback and memory.suggestions are present, you are revising a previous draft — use that feedback to improve.',
    'If no feedback exists, write from scratch.',
    'Keep the draft under 250 words. Be clear and precise.',
    'You MUST save your output by calling save_to_memory with key "draft".',
  ].join(' '),
  temperature: 0.7,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'constraints', 'feedback', 'suggestions', 'draft'],
    write_keys: ['draft'],
  },
};

const evaluatorAgent: AgentRegistryEntry = {
  id: EVALUATOR_ID,
  name: 'Evaluator Agent',
  description: 'Scores a draft on quality and provides feedback',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a writing evaluator.',
    'Read the draft and score it on clarity, accuracy, engagement, and conciseness.',
    'You MUST call save_to_memory THREE times:',
    '1. key "score" — a single number between 0 and 1 (e.g. 0.72).',
    '2. key "feedback" — a brief paragraph explaining what works and what does not.',
    '3. key "suggestions" — a bullet list of specific improvements.',
    'Scoring guide: 0.0–0.4 = poor, 0.5–0.6 = needs work, 0.7–0.79 = good but improvable, 0.8–0.89 = strong, 0.9–1.0 = exceptional.',
    'A draft that is clear, accurate, well-structured, and meets the constraints should score 0.8 or above.',
    'Do not be needlessly harsh — if the draft genuinely meets the goal, reflect that in the score.',
  ].join(' '),
  temperature: 0.3,
  max_steps: 5,
  tools: [],
  permissions: {
    read_keys: ['goal', 'constraints', 'draft'],
    write_keys: ['score', 'feedback', 'suggestions'],
  },
};

const publisherAgent: AgentRegistryEntry = {
  id: PUBLISHER_ID,
  name: 'Publisher Agent',
  description: 'Produces the final polished version',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a publishing editor.',
    'Take the approved draft and produce a final, polished version.',
    'Fix any remaining grammar, style, or clarity issues.',
    'Keep the spirit and structure of the original draft intact.',
    'You MUST save your output by calling save_to_memory with key "final_output".',
  ].join(' '),
  temperature: 0.5,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['goal', 'draft'],
    write_keys: ['final_output'],
  },
};

const registry = new InMemoryAgentRegistry();
registry.register(writerAgent);
registry.register(evaluatorAgent);
registry.register(publisherAgent);
configureAgentFactory(registry);

// Configure LLM providers — built-in OpenAI + Anthropic are pre-registered.
// Add custom providers here (e.g., Groq, Ollama) via providers.register().
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 2. Define the graph ─────────────────────────────────────────────────
// Cyclic graph with conditional edges:
//   writer → evaluator ──[score >= 0.8]──→ publisher (done)
//                │
//                └──[score < 0.8]──→ writer (loop back)

const now = new Date();

const graph: Graph = {
  id: uuidv4(),
  name: 'Eval Loop',
  description: 'Cyclic write-evaluate-revise loop with conditional quality gate',
  version: '1.0.0',
  created_at: now,
  updated_at: now,

  nodes: [
    {
      id: 'writer',
      type: 'agent',
      agent_id: WRITER_ID,
      read_keys: ['goal', 'constraints', 'feedback', 'suggestions', 'draft'],
      write_keys: ['draft'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'evaluator',
      type: 'agent',
      agent_id: EVALUATOR_ID,
      read_keys: ['goal', 'constraints', 'draft'],
      write_keys: ['score', 'feedback', 'suggestions'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'publisher',
      type: 'agent',
      agent_id: PUBLISHER_ID,
      read_keys: ['goal', 'draft'],
      write_keys: ['final_output'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
  ],

  edges: [
    // writer always goes to evaluator
    {
      id: 'writer-to-evaluator',
      source: 'writer',
      target: 'evaluator',
      condition: { type: 'always' },
    },
    // loop back: evaluator → writer when score < 0.8
    // (listed first so it matches before the exit edge)
    {
      id: 'evaluator-to-writer',
      source: 'evaluator',
      target: 'writer',
      condition: { type: 'conditional', condition: 'number(memory.score) < 0.8' },
    },
    // quality gate: evaluator → publisher when score >= 0.8
    {
      id: 'evaluator-to-publisher',
      source: 'evaluator',
      target: 'publisher',
      condition: { type: 'conditional', condition: 'number(memory.score) >= 0.8' },
    },
  ],

  start_node: 'writer',
  end_nodes: ['publisher'],
};

// ─── 3. Create initial state ─────────────────────────────────────────────

const initialState: WorkflowState = {
  workflow_id: graph.id,
  run_id: uuidv4(),
  created_at: now,
  updated_at: now,
  goal: 'Write a concise explanation of quantum computing for a general audience.',
  constraints: [
    'Under 250 words',
    'No jargon without explanation',
    'Cover qubits, superposition, and entanglement',
    'Suitable for someone with no physics background',
  ],
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  total_tokens_used: 0,
  total_cost_usd: 0,
  _cost_alert_thresholds_fired: [],
  visited_nodes: [],
  max_iterations: 20,
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
  logger.info('Starting eval-loop workflow...\n');

  try {
    const finalState = await runner.run();

    if (finalState.status === 'completed') {
      // Count iterations from the visited_nodes cycle
      const evalCount = finalState.visited_nodes.filter((n: string) => n === 'evaluator').length;

      console.log('\n═══ Results ═══');
      console.log(`  Iterations: ${evalCount} evaluation round(s)`);
      console.log(`  Final score: ${finalState.memory.score ?? '(unknown)'}`);
      console.log(`  Path: ${finalState.visited_nodes.join(' → ')}`);

      console.log('\n═══ Evaluator Feedback (last round) ═══');
      console.log(finalState.memory.feedback ?? '(none)');

      console.log('\n═══ Published Output ═══');
      console.log(finalState.memory.final_output ?? '(none)');

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
