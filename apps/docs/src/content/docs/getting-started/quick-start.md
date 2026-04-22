---
title: Quick Start
description: Install MC-AI and run your first workflow in under 5 minutes.
---

Let's install MC-AI, set up an LLM provider, and run a complete workflow with persistence.

## 1. Installation

MC-AI requires **Node.js 22+** (ES Modules).

Install the core orchestrator package, and optionally the postgres persistence package if you want durable database storage:

```bash
npm install @mcai/orchestrator

# Optional PostgreSQL persistence adapter
npm install @mcai/orchestrator-postgres
```

Since MC-AI uses the Vercel AI SDK under the hood, ensure you have the required provider installed for your LLM of choice (e.g., `@ai-sdk/anthropic` or `@ai-sdk/openai`).

## 2. API Keys

You will need an API key for your chosen LLM provider. For this quick start, we'll use Anthropic.

Set your environment variable:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

## 3. Minimal Workflow Example

Here is a complete, standalone example of a simple generative workflow. 

This script configures the provider, creates an Agent that writes a draft and saves it to a specific memory key, sets up the graph definition, and runs it with an in-memory persistence layer.

Create a file named `workflow.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';
import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  ProviderRegistry,
  createProviderRegistry,
  configureProviderRegistry,
  type Graph,
  type WorkflowState,
} from '@mcai/orchestrator';

async function main() {
  // 1. Configure LLM Providers
  const providers = createProviderRegistry();
  configureProviderRegistry(providers);

  // 2. Register an Agent Configuration
  const registry = new InMemoryAgentRegistry();
  const agentId = uuidv4();
  
  registry.register({
    id: agentId,
    name: 'Research Writer',
    model: 'claude-sonnet-4-20250514', // Ensure this matches your provider
    provider: 'anthropic',
    system_prompt: 'You are an expert technical writer. Write a concise summary of the goal.',
    temperature: 0.7,
    max_steps: 3,
    tools: [],
    // Security definitions: This agent can only read 'goal' and write to 'draft'
    permissions: { read_keys: ['goal'], write_keys: ['draft'] },
  });
  configureAgentFactory(registry);

  // 3. Define the Graph
  const graph: Graph = {
    id: uuidv4(),
    name: 'Simple Writer Workflow',
    version: '1.0.0',
    nodes: [
      {
        id: 'write_node', 
        type: 'agent', 
        agent_id: agentId,
        read_keys: ['goal'], 
        write_keys: ['draft'],
      }
    ],
    edges: [], // Blank edges means it simply executes the start node and finishes
    start_node: 'write_node',
    end_nodes: ['write_node'],
    created_at: new Date(),
    updated_at: new Date(),
  };

  // 4. Initialize the Workflow State
  const state: WorkflowState = {
    workflow_id: graph.id,
    run_id: uuidv4(),
    goal: 'Explain how transformers work in AI.',
    status: 'pending',
    memory: {},
    visited_nodes: [],
    iteration_count: 0,
    retry_count: 0,
    max_retries: 3,
    max_iterations: 10,
    max_execution_time_ms: 60_000,
    compensation_stack: [],
    created_at: new Date(),
    updated_at: new Date(),
  };

  // 5. Setup Persistence and Run
  const persistence = new InMemoryPersistenceProvider();
  const runner = new GraphRunner(graph, state, {
    // This hook fires after every single state change
    persistStateFn: async (s) => { 
      await persistence.saveWorkflowState(s); 
      console.log(`[State Persisted] Status: ${s.status}, Node: ${s.visited_nodes.slice(-1)[0]}`);
    },
  });

  console.log("Starting workflow...");
  const result = await runner.run();
  
  console.log("\n--- Final Output ---");
  console.log(result.memory.draft);
}

main().catch(console.error);
```

## Adding Durable Persistence (PostgreSQL)

While `InMemoryPersistenceProvider` is great for scripts, production environments require durability so workflows can be paused and resumed across server restarts.

If you installed `@mcai/orchestrator-postgres`, you can replace the in-memory provider with a Postgres-backed persistence layer. It automatically handles persisting the state and maintaining the event sourcing logs for durable execution and rollbacks.

```typescript
import { PostgresPersistenceProvider } from '@mcai/orchestrator-postgres';

// Ensure your database string is configured
const dbUrl = process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/mcai';

// Initialize the provider
const persistence = new PostgresPersistenceProvider(dbUrl);

// Hook it into the runner exactly like before
const runner = new GraphRunner(graph, state, {
  persistStateFn: async (s) => { await persistence.saveWorkflowState(s); },
  // Provide the event log writer for durable replay capabilities
  eventLog: persistence.getEventLogWriter(), 
});
```

## Next steps

- [Core Concepts](/concepts/overview/) — deep dive into how Graphs, Nodes, and Reducers work.
- [Workflow Patterns](/patterns/supervisor/) — see examples of powerful multi-agent patterns you can build.
