/**
 * Competitive Analysis — Dogfood Example
 *
 * A full-stack workflow that exercises every major MC-AI pattern in a single
 * graph, running through the WorkflowWorker distributed execution layer:
 *
 *   1. Supervisor dynamically routes between discovery + research phases
 *   2. Discovery agent finds top orchestration frameworks via MCP web search
 *   3. Map node fans out to parallel Deep Researcher agents (MCP fetch)
 *   4. Synthesizer merges parallel results into a comparison matrix
 *   5. Evaluator scores the matrix (self-annealing loop, threshold 0.8)
 *   6. Approval gate pauses for human review (HITL)
 *   7. WorkflowWorker handles the full lifecycle: queue → claim → heartbeat →
 *      HITL release → resume → ack
 *
 * Patterns: Supervisor, Map-Reduce, Self-Annealing, Human-in-the-Loop, MCP Tools, WorkflowWorker
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY for Claude Sonnet agents
 *   - BRAVE_API_KEY for web search (https://brave.com/search/api/)
 *   - uvx (Python uv package manager) for the fetch MCP server
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... BRAVE_API_KEY=BSA-... \
 *     npx tsx examples/competitive-analysis/run.ts
 */

import * as readline from 'node:readline/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  InMemoryMCPServerRegistry,
  InMemoryEventLogWriter,
  InMemoryWorkflowQueue,
  WorkflowWorker,
  MCPConnectionManager,
  registerDefaultMCPServers,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  createGraph,
  createWorkflowState,
  createLogger,
  type HumanResponse,
  type ToolSource,
} from '@mcai/orchestrator';

// ─── 0. Fail fast if no API keys ────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... BRAVE_API_KEY=BSA-... npx tsx examples/competitive-analysis/run.ts');
  process.exit(1);
}

if (!process.env.BRAVE_API_KEY) {
  console.warn('Warning: BRAVE_API_KEY not set — web search will fail at runtime.');
  console.warn('Get a free key at https://brave.com/search/api/\n');
}

const logger = createLogger('example.competitive');

// ─── 1. Register MCP servers ────────────────────────────────────────────

const mcpRegistry = new InMemoryMCPServerRegistry();
const registeredServers = await registerDefaultMCPServers(mcpRegistry);
logger.info(`Registered MCP servers: ${registeredServers.join(', ')}`);

const mcpManager = new MCPConnectionManager(mcpRegistry);

// ─── 2. Register agents ─────────────────────────────────────────────────
// 5 agents: Supervisor, Discovery, Deep Researcher, Synthesizer, Evaluator

const agentRegistry = new InMemoryAgentRegistry();

const SUPERVISOR_ID = agentRegistry.register({
  name: 'Analysis Supervisor',
  description: 'Orchestrates the competitive analysis workflow: discovery → research → synthesis',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a project supervisor coordinating a competitive analysis of AI orchestration frameworks.',
    'You manage five team members:',
    '  - "discovery": Searches the web to find the top AI orchestration frameworks.',
    '  - "mapper": Fans out parallel research on each discovered framework.',
    '  - "synthesizer": Merges all parallel research into a comparison matrix.',
    '  - "evaluator": Scores the comparison matrix quality (0-1).',
    '  - "review": Pauses for human approval of the final matrix.',
    '',
    'Your workflow:',
    '1. Delegate to "discovery" to find frameworks.',
    '2. If memory.frameworks exists (even as a JSON string), proceed to "mapper".',
    '   Do NOT re-delegate to discovery if any framework data exists.',
    '3. Delegate to "mapper" for parallel deep research.',
    '4. After mapper completes (mapper_results populated), delegate to "synthesizer".',
    '5. After synthesis (comparison_matrix in memory), delegate to "evaluator".',
    '6. Read memory.score after evaluation:',
    '   - If score < 0.8: re-delegate to "synthesizer" (it will use memory.feedback to improve).',
    '   - If score >= 0.8: delegate to "review" for human approval.',
    '7. After human approval (memory.human_decision === "approved"), route to "__done__".',
    '',
    'Review memory carefully at each step. Follow the numbered steps in order.',
  ].join('\n'),
  temperature: 0.3,
  max_steps: 3,
  tools: [],
  permissions: {
    read_keys: ['*'],
    write_keys: ['*'],
  },
});

const DISCOVERY_ID = agentRegistry.register({
  name: 'Discovery Researcher',
  description: 'Finds the top AI orchestration frameworks via web search',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a research specialist. Find the top 5 AI orchestration frameworks.',
    '',
    'REQUIRED OUTPUT: Call save_to_memory with key "frameworks" and a JSON array value.',
    'The value MUST be a real array, not a string. Example:',
    '  save_to_memory({ key: "frameworks", value: [{"name": "LangGraph", "url": "https://..."}, ...] })',
    '',
    'Steps:',
    '1. Run 2-3 brave_web_search queries for "top AI orchestration frameworks 2025 2026"',
    '2. Identify the 5 most significant frameworks with their doc/GitHub URLs',
    '3. Call save_to_memory with the array',
    '',
    'Do NOT run more than 3 searches. Save results as soon as you have 5 frameworks.',
  ].join('\n'),
  temperature: 0.5,
  max_steps: 5,
  tools: [
    { type: 'builtin', name: 'save_to_memory' },
    { type: 'mcp', server_id: 'web-search' },
  ] satisfies ToolSource[],
  permissions: {
    read_keys: ['goal'],
    write_keys: ['frameworks'],
  },
});

const DEEP_RESEARCHER_ID = agentRegistry.register({
  name: 'Deep Researcher',
  description: 'Researches one framework in depth by fetching its docs',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a research specialist assigned to investigate one specific AI orchestration framework.',
    'Your assigned framework is provided in _map_item (with "name" and "url" fields).',
    '',
    'REQUIRED OUTPUT: Call save_to_memory with key "research" containing your structured analysis.',
    'You MUST call save_to_memory even if fetch fails — use your existing knowledge of the framework.',
    '',
    'Steps:',
    '1. Fetch the URL from _map_item. If it fails, try ONE alternative URL (e.g. GitHub README).',
    '2. Do NOT retry the same URL or fetch more than 2 URLs total.',
    '3. Analyze the framework covering: architecture type, workflow patterns, persistence/recovery,',
    '   security model, language/runtime, and notable features.',
    '4. Call save_to_memory with key "research" — include your analysis even if based on prior knowledge.',
    '',
    'IMPORTANT: Do not spend all your steps on fetch retries. Save your analysis early.',
  ].join('\n'),
  temperature: 0.5,
  max_steps: 4,
  tools: [
    { type: 'builtin', name: 'save_to_memory' },
    { type: 'mcp', server_id: 'fetch' },
  ] satisfies ToolSource[],
  permissions: {
    read_keys: ['_map_item', '_map_index', '_map_total', 'goal'],
    write_keys: ['research'],
  },
});

const SYNTHESIZER_ID = agentRegistry.register({
  name: 'Matrix Synthesizer',
  description: 'Merges parallel research results into a comparison matrix',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a synthesis specialist creating a competitive analysis comparison matrix.',
    '',
    'INPUT: mapper_results is an array of objects. Each element has:',
    '  { index: number, node_id: string, updates: { research: "..." } }',
    'Extract the research text from each element\'s updates.research field.',
    'The original framework names are in the frameworks array (same order as mapper_results).',
    '',
    'If memory.feedback is present, you are revising a previous matrix — use that feedback to improve.',
    '',
    'Create a comprehensive markdown comparison matrix table covering at minimum:',
    '- Architecture type',
    '- Supported workflow patterns',
    '- Persistence / crash recovery',
    '- Security model',
    '- Language / runtime',
    'Add additional comparison dimensions you find relevant from the research.',
    '',
    'The matrix should be a well-formatted markdown table with one row per framework.',
    'Include a brief executive summary paragraph above the table.',
    '',
    'You MUST save your output by calling save_to_memory with key "comparison_matrix".',
  ].join('\n'),
  temperature: 0.4,
  max_steps: 3,
  tools: [{ type: 'builtin', name: 'save_to_memory' }],
  permissions: {
    read_keys: ['goal', 'frameworks', 'mapper_results', 'mapper_count', 'feedback'],
    write_keys: ['comparison_matrix'],
  },
});

const EVALUATOR_ID = agentRegistry.register({
  name: 'Quality Evaluator',
  description: 'Scores the comparison matrix quality and provides feedback',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a quality evaluator for competitive analysis documents.',
    'Read the comparison_matrix and score it on:',
    '- Completeness (covers all frameworks?)',
    '- Accuracy (claims supported by research?)',
    '- Structure (well-formatted markdown table?)',
    '- Usefulness (actionable insights?)',
    '',
    'You MUST call save_to_memory THREE times:',
    '1. key "score" — a single number between 0 and 1 (e.g. 0.75).',
    '2. key "feedback" — a brief paragraph explaining what works and what needs improvement.',
    '3. key "suggestions" — a bullet list of specific improvements.',
    '',
    'Scoring guide:',
    '  0.0–0.5 = poor/incomplete, 0.5–0.7 = needs work, 0.7–0.79 = good but improvable,',
    '  0.8–0.89 = strong, 0.9–1.0 = exceptional.',
    'If the matrix genuinely covers the goal well, give it a fair score.',
  ].join('\n'),
  temperature: 0.3,
  max_steps: 5,
  tools: [{ type: 'builtin', name: 'save_to_memory' }],
  permissions: {
    read_keys: ['comparison_matrix', 'goal'],
    write_keys: ['score', 'feedback', 'suggestions'],
  },
});

configureAgentFactory(agentRegistry);

const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 3. Define the graph ────────────────────────────────────────────────
//
// All nodes are managed by the supervisor in a hub-and-spoke topology:
//   supervisor ⇄ discovery, mapper, synthesizer, evaluator, review
//
// The supervisor drives the full lifecycle:
//   discovery → mapper → synthesizer → evaluator → (eval loop) → review → __done__
// Eval loop: if score < 0.8, supervisor re-delegates to synthesizer.
// HITL: review node pauses for human approval; on resume, supervisor routes to __done__.

const graph = createGraph({
  name: 'Competitive Analysis',
  description: 'Full-stack dogfood: supervisor → map-reduce → eval loop → HITL approval',

  nodes: [
    // ── Supervisor Phase ──
    {
      id: 'supervisor',
      type: 'supervisor',
      agent_id: SUPERVISOR_ID,
      read_keys: ['*'],
      write_keys: ['*'],
      supervisor_config: {
        managed_nodes: ['discovery', 'mapper', 'synthesizer', 'evaluator', 'review'],
        max_iterations: 15,
      },
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'discovery',
      type: 'agent',
      agent_id: DISCOVERY_ID,
      read_keys: ['goal'],
      write_keys: ['frameworks'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 2000, max_backoff_ms: 30000 },
      requires_compensation: false,
    },
    {
      id: 'mapper',
      type: 'map',
      map_reduce_config: {
        worker_node_id: 'researcher',
        items_path: '$.memory.frameworks',
        max_concurrency: 5,
        error_strategy: 'best_effort',
      },
      read_keys: ['*'],
      write_keys: ['mapper_results', 'mapper_errors', 'mapper_count', 'mapper_error_count'],
      failure_policy: { max_retries: 1, backoff_strategy: 'exponential', initial_backoff_ms: 2000, max_backoff_ms: 30000 },
      requires_compensation: false,
    },
    {
      id: 'researcher',
      type: 'agent',
      agent_id: DEEP_RESEARCHER_ID,
      read_keys: ['_map_item', '_map_index', '_map_total', 'goal'],
      write_keys: ['research'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 2000, max_backoff_ms: 30000 },
      requires_compensation: false,
    },
    {
      id: 'synthesizer',
      type: 'agent',
      agent_id: SYNTHESIZER_ID,
      read_keys: ['goal', 'frameworks', 'mapper_results', 'mapper_count', 'feedback'],
      write_keys: ['comparison_matrix'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },

    // ── Eval + HITL (managed by supervisor) ──
    {
      id: 'evaluator',
      type: 'agent',
      agent_id: EVALUATOR_ID,
      read_keys: ['comparison_matrix', 'goal'],
      write_keys: ['score', 'feedback', 'suggestions'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      requires_compensation: false,
    },
    {
      id: 'review',
      type: 'approval',
      approval_config: {
        approval_type: 'human_review',
        prompt_message: 'Please review the competitive analysis matrix before finalizing.',
        review_keys: ['comparison_matrix', 'score', 'feedback'],
        timeout_ms: 600_000, // 10 minutes
        rejection_node_id: 'synthesizer',
      },
      read_keys: ['*'],
      write_keys: ['*', 'control_flow'],
      failure_policy: { max_retries: 1, backoff_strategy: 'fixed', initial_backoff_ms: 1000, max_backoff_ms: 1000 },
      requires_compensation: false,
    },
  ],

  edges: [
    // Supervisor ⇄ specialists (hub-and-spoke for all managed nodes)
    { source: 'supervisor', target: 'discovery' },
    { source: 'supervisor', target: 'mapper' },
    { source: 'supervisor', target: 'synthesizer' },
    { source: 'supervisor', target: 'evaluator' },
    { source: 'supervisor', target: 'review' },
    { source: 'discovery', target: 'supervisor' },
    { source: 'mapper', target: 'supervisor' },
    { source: 'synthesizer', target: 'supervisor' },
    { source: 'evaluator', target: 'supervisor' },
    { source: 'review', target: 'supervisor' },
  ],

  start_node: 'supervisor',
  end_nodes: [], // Supervisor terminates via __done__
});

// ─── 4. Create initial state ────────────────────────────────────────────

const initialState = createWorkflowState({
  workflow_id: graph.id,
  goal: [
    'Produce a comprehensive competitive analysis of the top 5 AI orchestration frameworks.',
    'Compare them across at minimum: architecture type, supported workflow patterns,',
    'persistence/crash recovery, and security model.',
    'Add any additional dimensions you find relevant during research.',
  ].join(' '),
  constraints: [
    'Discover frameworks via live web search — do not hardcode',
    'Research each framework by fetching its documentation',
    'Produce a well-formatted markdown comparison table',
    'Include an executive summary above the table',
  ],
  max_iterations: 50,
  max_execution_time_ms: 600_000, // 10 minutes
});

// ─── 5. Interactive HITL prompt ─────────────────────────────────────────

async function promptHuman(matrix: string, score: unknown, feedback: unknown): Promise<HumanResponse> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║          HUMAN REVIEW REQUIRED                       ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    console.log('═══ Comparison Matrix ═══\n');
    console.log(matrix);

    console.log('\n═══ Evaluator Score ═══');
    console.log(`  Score: ${score}`);
    console.log(`  Feedback: ${feedback}`);

    console.log('\n──────────────────────────────────────────');

    const answer = await rl.question('\nApprove this analysis? (yes/no): ');
    const approved = answer.trim().toLowerCase().startsWith('y');

    if (approved) {
      const notes = await rl.question('Any notes? (press Enter to skip): ');
      return { decision: 'approved', data: notes || 'Approved.' };
    } else {
      const reason = await rl.question('Reason for rejection: ');
      return { decision: 'rejected', data: reason || 'Rejected by reviewer.' };
    }
  } finally {
    rl.close();
  }
}

// ─── 6. Run via WorkflowWorker ──────────────────────────────────────────

async function main() {
  logger.info('Starting competitive analysis workflow (WorkflowWorker mode)...\n');

  // Set up in-memory infrastructure
  const persistence = new InMemoryPersistenceProvider();
  const eventLog = new InMemoryEventLogWriter();
  const queue = new InMemoryWorkflowQueue();

  // Save the graph so the worker can load it
  await persistence.saveGraph(graph);

  // Create and start the worker
  const worker = new WorkflowWorker({
    queue,
    persistence,
    eventLog,
    pollIntervalMs: 500,
    heartbeatIntervalMs: 30_000,
    reclaimIntervalMs: 15_000,
    shutdownGracePeriodMs: 30_000,
    runnerOptionsFactory: () => ({
      toolResolver: mcpManager,
      middleware: [{
        // LLMs sometimes save arrays as JSON strings. This middleware
        // parses memory.frameworks before the map node tries to fan out.
        beforeNodeExecute: async ({ node, state }) => {
          if (node.id === 'mapper' && typeof state.memory.frameworks === 'string') {
            try {
              const parsed = JSON.parse(state.memory.frameworks as string);
              if (Array.isArray(parsed)) {
                logger.info('Normalized memory.frameworks from string to array');
                state.memory.frameworks = parsed;
              }
            } catch {
              logger.warn('Failed to parse memory.frameworks as JSON');
            }
          }
        },
      }],
    }),
  });

  // Worker event listeners
  worker.on('job:claimed', ({ jobId, runId }) => {
    logger.info(`Job claimed: ${jobId} (run: ${runId})`);
  });

  worker.on('job:completed', ({ jobId }) => {
    logger.info(`Job completed: ${jobId}`);
  });

  worker.on('job:released', ({ jobId }) => {
    logger.info(`Job released (HITL pause): ${jobId}`);
  });

  worker.on('job:failed', ({ jobId, error }) => {
    logger.error(`Job failed: ${jobId} — ${error}`);
  });

  worker.on('job:dead_letter', ({ jobId, error }) => {
    logger.error(`Job dead-lettered: ${jobId} — ${error}`);
  });

  await worker.start();
  logger.info('Worker started. Enqueuing job...');

  try {
    // Enqueue the initial job
    const runId = initialState.run_id;
    const startJobId = await queue.enqueue({
      type: 'start',
      run_id: runId,
      graph_id: graph.id,
      initial_state: initialState,
    });

    // Wait for the job to complete or pause (HITL)
    let finalState = await waitForTerminalState(worker, queue, runId, persistence);

    // Handle HITL pause
    if (finalState?.status === 'waiting') {
      // The queue's `release()` transitions the job to `paused` status,
      // so the worker won't re-claim it. We ack the original job to clean
      // it up, since a separate `resume` job will continue the workflow.
      await queue.ack(startJobId);

      logger.info('Workflow paused for human review.');

      const matrix = (finalState.memory.comparison_matrix as string) ?? '(no matrix generated)';
      const score = finalState.memory.score;
      const feedback = finalState.memory.feedback;

      const humanResponse = await promptHuman(matrix, score, feedback);
      console.log(`\nReviewer decision: ${humanResponse.decision}`);

      if (humanResponse.decision === 'rejected') {
        console.log('\n═══ Workflow Rejected ═══');
        console.log(`Reason: ${humanResponse.data}`);
        console.log('\n═══ Stats ═══');
        console.log(`  Nodes visited:  ${finalState.visited_nodes.join(' → ')}`);
        console.log(`  Tokens used:    ${finalState.total_tokens_used}`);
        console.log(`  Cost (USD):     $${(finalState.total_cost_usd ?? 0).toFixed(4)}`);
        return;
      }

      // Enqueue the resume job — worker is still running and will claim it
      logger.info('Enqueueing resume job...');
      await queue.enqueue({
        type: 'resume',
        run_id: runId,
        graph_id: graph.id,
        human_response: humanResponse,
      });

      // Wait for final completion
      finalState = await waitForTerminalState(worker, queue, runId, persistence);
    }

    // Output results
    if (finalState && (finalState.status === 'completed' || finalState.status === 'waiting')) {
      const matrix = (finalState.memory.comparison_matrix as string) ?? '';

      if (matrix) {
        // Write the matrix to a file
        const outputDir = path.resolve(process.cwd(), '../../docs');
        const outputPath = path.join(outputDir, 'competitive-analysis.md');

        try {
          await fs.mkdir(outputDir, { recursive: true });
          const header = `# Competitive Analysis: AI Orchestration Frameworks\n\n*Generated by MC-AI dogfood workflow on ${new Date().toISOString().split('T')[0]}*\n\n`;
          await fs.writeFile(outputPath, header + matrix, 'utf-8');
          console.log(`\n═══ Output Written ═══`);
          console.log(`  ${outputPath}`);
        } catch (err) {
          console.error(`Failed to write output file: ${(err as Error).message}`);
          console.log('\n═══ Comparison Matrix (stdout) ═══');
          console.log(matrix);
        }
      }

      console.log('\n═══ Supervisor Routing History ═══');
      for (const entry of finalState.supervisor_history ?? []) {
        console.log(`  [iter ${entry.iteration}] → ${entry.delegated_to} (${entry.reasoning})`);
      }

      console.log('\n═══ Stats ═══');
      console.log(`  Status:         ${finalState.status}`);
      console.log(`  Nodes visited:  ${finalState.visited_nodes.join(' → ')}`);
      console.log(`  Tokens used:    ${finalState.total_tokens_used}`);
      console.log(`  Cost (USD):     $${(finalState.total_cost_usd ?? 0).toFixed(4)}`);

      const depth = await queue.getQueueDepth();
      console.log(`\n═══ Queue State ═══`);
      console.log(`  Waiting:     ${depth.waiting}`);
      console.log(`  Active:      ${depth.active}`);
      console.log(`  Paused:      ${depth.paused}`);
      console.log(`  Dead Letter: ${depth.dead_letter}`);
    } else {
      console.error(`Workflow ended with status: ${finalState?.status ?? 'unknown'}`);
      if (finalState?.last_error) {
        console.error(`Error: ${finalState.last_error}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  } finally {
    await worker.stop();
    await mcpManager.closeAll();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Wait for the worker to finish processing the job (either completed or HITL pause).
 * Polls the persistence layer for the final state.
 */
async function waitForTerminalState(
  worker: WorkflowWorker,
  queue: InMemoryWorkflowQueue,
  runId: string,
  persistence: InMemoryPersistenceProvider,
): Promise<import('@mcai/orchestrator').WorkflowState | null> {
  return new Promise((resolve) => {
    const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timeout']);

    const check = async () => {
      const state = await persistence.loadLatestWorkflowState(runId);
      if (state && (terminalStatuses.has(state.status) || state.status === 'waiting')) {
        resolve(state);
        return true;
      }
      return false;
    };

    // Listen for worker events as a fast path
    const onComplete = async () => {
      // Small delay for persistence to flush
      setTimeout(async () => {
        if (!(await check())) {
          // Not yet — keep polling
        }
      }, 200);
    };

    worker.on('job:completed', onComplete);
    worker.on('job:released', onComplete);
    worker.on('job:failed', onComplete);
    worker.on('job:dead_letter', onComplete);

    // Also poll periodically as a fallback
    const interval = setInterval(async () => {
      if (await check()) {
        clearInterval(interval);
        worker.removeListener('job:completed', onComplete);
        worker.removeListener('job:released', onComplete);
        worker.removeListener('job:failed', onComplete);
        worker.removeListener('job:dead_letter', onComplete);
      }
    }, 1000);
  });
}

main();
