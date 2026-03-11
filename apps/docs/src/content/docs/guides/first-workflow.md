---
title: Your First Workflow
description: Build a complete workflow step-by-step — from graph definition to execution.
---

This guide walks you through building a **linear 2-node workflow**: a Researcher gathers notes, then a Writer produces a polished summary.

## Step 1: Define the graph

```typescript
import { v4 as uuidv4 } from 'uuid';
import type { Graph } from '@mcai/orchestrator';

const RESEARCHER_ID = uuidv4();
const WRITER_ID = uuidv4();

const graph: Graph = {
  id: uuidv4(),
  name: 'Research & Write',
  description: 'Simple linear workflow',
  version: '1.0.0',

  nodes: [
    {
      id: 'research',
      type: 'agent',
      agent_id: RESEARCHER_ID,
      read_keys: ['goal'],
      write_keys: ['notes'],
      failure_policy: {
        max_retries: 3,
        backoff_strategy: 'exponential',
        initial_backoff_ms: 1000,
        max_backoff_ms: 60000,
      },
      requires_compensation: false,
    },
    {
      id: 'writer',
      type: 'agent',
      agent_id: WRITER_ID,
      read_keys: ['goal', 'notes'],
      write_keys: ['draft'],
      failure_policy: { max_retries: 1 },
      requires_compensation: false,
    },
  ],

  edges: [
    {
      id: 'e1',
      source: 'research',
      target: 'writer',
      condition: { type: 'always' },
    },
  ],

  start_node: 'research',
  end_nodes: ['writer'],
  created_at: new Date(),
  updated_at: new Date(),
};
```

## Step 2: Register agents

```typescript
import {
  InMemoryAgentRegistry,
  configureAgentFactory,
  createProviderRegistry,
  configureProviderRegistry,
} from '@mcai/orchestrator';

const registry = new InMemoryAgentRegistry();

registry.register({
  id: RESEARCHER_ID,
  name: 'Researcher',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'You are a research specialist. Investigate the topic and save thorough research notes using save_to_memory with key "notes".',
  temperature: 0.5,
  max_steps: 5,
  tools: [],
  permissions: { read_keys: ['goal'], write_keys: ['notes'] },
});

registry.register({
  id: WRITER_ID,
  name: 'Writer',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'You are a writer. Read the research notes from memory and produce a polished summary. Save it using save_to_memory with key "draft".',
  temperature: 0.7,
  max_steps: 3,
  tools: [],
  permissions: { read_keys: ['goal', 'notes'], write_keys: ['draft'] },
});

configureAgentFactory(registry);

// Configure LLM providers (OpenAI + Anthropic are built-in)
const providers = createProviderRegistry();
configureProviderRegistry(providers);
```

## Step 3: Create initial state

```typescript
import type { WorkflowState } from '@mcai/orchestrator';

const initialState: WorkflowState = {
  workflow_id: graph.id,
  run_id: uuidv4(),
  created_at: new Date(),
  updated_at: new Date(),
  goal: 'Write a concise overview of how transformer models work in AI',
  status: 'pending',
  iteration_count: 0,
  retry_count: 0,
  max_retries: 3,
  memory: {},
  visited_nodes: [],
  max_iterations: 10,
  compensation_stack: [],
  max_execution_time_ms: 120_000,
};
```

## Step 4: Run

```typescript
import { GraphRunner, InMemoryPersistenceProvider } from '@mcai/orchestrator';

const persistence = new InMemoryPersistenceProvider();
const runner = new GraphRunner(graph, initialState, {
  persistStateFn: async (s) => {
    await persistence.saveWorkflowState(s);
  },
});

// Listen for events
runner.on('node:complete', ({ node_id, duration_ms }) => {
  console.log(`✅ ${node_id} finished in ${duration_ms}ms`);
});

const finalState = await runner.run();
console.log('Draft:', finalState.memory.draft);
```

## Using streaming instead

For real-time output, use `stream()` instead of `run()`:

```typescript
import { isTerminalEvent } from '@mcai/orchestrator';

for await (const event of runner.stream()) {
  switch (event.type) {
    case 'agent:token_delta':
      process.stdout.write(event.token);
      break;
    case 'node:complete':
      console.log(`\n✅ ${event.node_id} done in ${event.duration_ms}ms`);
      break;
    case 'workflow:complete':
      console.log('\nDraft:', event.state.memory.draft);
      break;
  }
}
```

## Next steps

- [Supervisor](/patterns/supervisor/) — add dynamic LLM-powered routing
- [Custom LLM Providers](/guides/custom-providers/) — use Groq, Ollama, or other providers
- [Adding MCP Tools](/guides/adding-tools/) — give agents external capabilities
