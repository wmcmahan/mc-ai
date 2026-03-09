---
title: Quick Start
description: Run your first MC-AI workflow in under 5 minutes.
---

The fastest way to see the engine in action is to run a built-in example. This requires Node.js 22+ and an Anthropic API key.

## Run an example

```bash
git clone https://gitlab.com/wmcmahan/mc-ai.git
cd mc-ai
npm install
cd packages/orchestrator

# Run a 2-node linear workflow: Researcher → Writer
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts
```

To use OpenAI instead, change `provider` to `'openai'`, update the `model` field (e.g. `'gpt-4o'`), and set `OPENAI_API_KEY`.

## More examples

```bash
# Supervisor routing between specialists
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts

# Map-Reduce fan-out with parallel workers
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/map-reduce/map-reduce.ts

# Human-in-the-loop approval gate
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/human-in-the-loop/human-in-the-loop.ts

# Real-time event streaming
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/streaming/streaming.ts
```

## Minimal code

```typescript
import { v4 as uuidv4 } from 'uuid';
import {
  GraphRunner,
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  configureAgentFactory,
  ProviderRegistry,
  registerBuiltInProviders,
  configureProviderRegistry,
  type Graph,
  type WorkflowState,
} from '@mcai/orchestrator';

// 1. Register an agent (agents are config, not classes)
const registry = new InMemoryAgentRegistry();
const agentId = uuidv4();
registry.register({
  id: agentId,
  name: 'Writer',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'Write a summary. Save it with save_to_memory key "draft".',
  temperature: 0.7,
  max_steps: 3,
  tools: [],
  permissions: { read_keys: ['goal'], write_keys: ['draft'] },
});
configureAgentFactory(registry);

// 2. Configure LLM providers (OpenAI + Anthropic are built-in)
const providers = new ProviderRegistry();
registerBuiltInProviders(providers);
configureProviderRegistry(providers);

// 3. Define a graph
const graph: Graph = {
  id: uuidv4(),
  name: 'Simple',
  version: '1.0.0',
  nodes: [{
    id: 'write', type: 'agent', agent_id: agentId,
    read_keys: ['goal'], write_keys: ['draft'],
  }],
  edges: [],
  start_node: 'write',
  end_nodes: ['write'],
  created_at: new Date(),
  updated_at: new Date(),
};

// 4. Run
const state: WorkflowState = {
  workflow_id: graph.id, run_id: uuidv4(),
  goal: 'Explain how transformers work',
  status: 'pending', memory: {}, visited_nodes: [],
  iteration_count: 0, retry_count: 0, max_retries: 3,
  max_iterations: 50, max_execution_time_ms: 120_000,
  compensation_stack: [],
  created_at: new Date(), updated_at: new Date(),
};

const persistence = new InMemoryPersistenceProvider();
const runner = new GraphRunner(graph, state, {
  persistStateFn: async (s) => { await persistence.saveWorkflowState(s); },
});

const result = await runner.run();
console.log(result.memory.draft);
```

## Next steps

- [How MC-AI Works](/concepts/overview/) — understand the core architecture
- [Your First Workflow](/guides/first-workflow/) — build a workflow step-by-step
