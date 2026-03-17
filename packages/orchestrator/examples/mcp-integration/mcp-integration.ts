/**
 * MCP Integration — Runnable Example
 *
 * Demonstrates how to use the MCPConnectionManager to connect to external
 * MCP servers and expose their tools to agents. Uses ToolSource declarations
 * with `type: "mcp"` references resolved at runtime.
 *
 * This example uses a mock MCP server for illustration. Replace with a real
 * server URL (stdio or SSE transport) for production use.
 *
 * Demonstrates: MCP tool resolution, ToolSource declarations, tool adapter,
 * taint tracking for MCP tool outputs, connection lifecycle.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/mcp-integration/mcp-integration.ts
 */

import {
  GraphRunner,
  InMemoryAgentRegistry,
  InMemoryMCPServerRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
  MCPConnectionManager,
  createGraph,
  createWorkflowState,
  createLogger,
} from '@mcai/orchestrator';
import type { ToolSource } from '@mcai/orchestrator';

// ─── 0. Fail fast if no API key ──────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is required');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/mcp-integration/mcp-integration.ts');
  process.exit(1);
}

const logger = createLogger('example.mcp');

// ─── 1. Register MCP servers ────────────────────────────────────────────
// In production, these would point to real MCP server processes.
// The MCPServerRegistry stores transport configs + access control.

const mcpRegistry = new InMemoryMCPServerRegistry();

// Register a hypothetical web-search MCP server.
// For a real setup, use stdio or SSE transport:
//   { type: 'stdio', command: 'npx', args: ['-y', '@anthropic/mcp-server-web-search'] }
//   { type: 'sse', url: 'http://localhost:3001/sse' }
mcpRegistry.register({
  id: 'web-search',
  name: 'Web Search MCP',
  description: 'Provides web search capabilities via MCP',
  transport: {
    type: 'sse',
    url: process.env.MCP_WEB_SEARCH_URL ?? 'http://localhost:3001/sse',
  },
  allowed_agents: [], // Empty = all agents can use it
  timeout_ms: 30_000,
});

// ─── 2. Register agents with MCP tool references ────────────────────────
// Tools are declared as ToolSource[] — the MCPConnectionManager resolves
// them at execution time by connecting to the registered servers.

const registry = new InMemoryAgentRegistry();

// Agent that uses both a builtin tool and an MCP server tool
const RESEARCHER_ID = registry.register({
  name: 'MCP Research Agent',
  description: 'Researches topics using web search via MCP',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a research agent with access to web search.',
    'Use the web_search tool to find current information about the topic.',
    'Summarize your findings concisely.',
    'Save your research using save_to_memory with key "research_notes".',
  ].join(' '),
  temperature: 0.5,
  max_steps: 5,
  // ToolSource declarations — resolved at runtime by MCPConnectionManager
  tools: [
    { type: 'builtin', name: 'save_to_memory' },
    { type: 'mcp', server_id: 'web-search' },      // All tools from this server
    // To pick specific tools: { type: 'mcp', server_id: 'web-search', tool_name: 'search' }
  ] satisfies ToolSource[],
  permissions: {
    read_keys: ['*'],
    write_keys: ['research_notes'],
  },
});

const WRITER_ID = registry.register({
  name: 'Writer Agent',
  description: 'Writes summaries from research notes',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: [
    'You are a writer. Using the research notes, produce a clear summary.',
    'Save your output using save_to_memory with key "summary".',
  ].join(' '),
  temperature: 0.7,
  max_steps: 3,
  tools: [{ type: 'builtin', name: 'save_to_memory' }],
  permissions: {
    read_keys: ['research_notes'],
    write_keys: ['summary'],
  },
});

configureAgentFactory(registry);
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// ─── 3. Create the MCPConnectionManager ─────────────────────────────────
// This connects to MCP servers and resolves ToolSource[] → AI SDK tools.

const mcpManager = new MCPConnectionManager(mcpRegistry);

// ─── 4. Define the graph ────────────────────────────────────────────────

const graph = createGraph({
  name: 'MCP Integration',
  description: 'Two-node workflow: MCP-powered research → write summary',

  nodes: [
    {
      id: 'research',
      type: 'agent',
      agent_id: RESEARCHER_ID,
      read_keys: ['*'],
      write_keys: ['research_notes'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 30000 },
      requires_compensation: false,
    },
    {
      id: 'write',
      type: 'agent',
      agent_id: WRITER_ID,
      read_keys: ['research_notes'],
      write_keys: ['summary'],
      failure_policy: { max_retries: 2, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 30000 },
      requires_compensation: false,
    },
  ],

  edges: [
    { source: 'research', target: 'write' },
  ],

  start_node: 'research',
  end_nodes: ['write'],
  strict_taint: true, // Reject routing decisions based on tainted (MCP-sourced) data
});

// ─── 5. Run ─────────────────────────────────────────────────────────────

async function main() {
  logger.info('Starting MCP integration example...');
  logger.info('NOTE: This requires a running MCP server. If you see connection errors,');
  logger.info('start an MCP server or set MCP_WEB_SEARCH_URL to a valid endpoint.\n');

  const state = createWorkflowState({
    workflow_id: graph.id,
    goal: 'Research the latest developments in quantum computing and write a brief summary',
    constraints: ['Keep the summary under 300 words'],
    max_execution_time_ms: 120_000,
  });

  // The MCPConnectionManager resolves ToolSource[] → AI SDK tools at execution time.
  // Pass it via the toolResolver option so the GraphRunner can resolve MCP tools
  // for each agent node.
  const runner = new GraphRunner(graph, state, {
    toolResolver: mcpManager,
  });

  try {
    const finalState = await runner.run();

    console.log('\n--- Results ---');
    console.log('Status:', finalState.status);
    console.log('\nResearch Notes:');
    console.log(finalState.memory.research_notes ?? '(none)');
    console.log('\nSummary:');
    console.log(finalState.memory.summary ?? '(none)');
    console.log('\nTokens used:', finalState.total_tokens_used);

    // Show taint tracking (MCP tool outputs are automatically tainted)
    const taintRegistry = finalState.memory._taint_registry as Record<string, unknown> | undefined;
    if (taintRegistry) {
      console.log('\nTaint Registry (MCP outputs marked):');
      for (const [key, meta] of Object.entries(taintRegistry)) {
        console.log(`  ${key}: ${JSON.stringify(meta)}`);
      }
    }
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    // Always clean up MCP connections
    await mcpManager.closeAll();
  }
}

main();
