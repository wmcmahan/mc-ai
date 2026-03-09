# @mcai/orchestrator

A graph engine for orchestrating AI agent workflows. Define agents, tools, supervisors, and routing logic as configuration — the engine handles execution, state, retries, and recovery.

```
Define Graph (nodes + edges) → GraphRunner.run() → Execute Nodes → Reduce State → Persist → Follow Edges → Done
```

## Install

```bash
npm install @mcai/orchestrator
```

**Peer dependencies**: `ai` (v6+), `zod`, and at least one provider adapter (`@ai-sdk/anthropic`, `@ai-sdk/openai`, or any Vercel AI SDK-compatible provider).

## 5-Minute Quick Start

The fastest way to see the engine in action is to run an example. This requires Node.js 22+ and an Anthropic API key.

```bash
git clone https://gitlab.com/wmcmahan/mc-ai.git
cd mc-ai
npm install
cd packages/orchestrator
npx tsc

# Run a 2-node linear workflow
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts
```

To use OpenAI instead, change `provider` to `'openai'`, update the `model` field (e.g. `'gpt-4o'`), and set `OPENAI_API_KEY`.

### Minimal Code

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
  system: 'Write a summary. Save it with save_to_memory key "draft".',
  temperature: 0.7,
  maxSteps: 3,
  tools: [],
  read_keys: ['goal'],
  write_keys: ['draft'],
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
  nodes: [{ id: 'write', type: 'agent', agent_id: agentId, read_keys: ['goal'], write_keys: ['draft'] }],
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

### Custom LLM Providers

The `ProviderRegistry` supports any Vercel AI SDK-compatible provider. OpenAI and Anthropic are built-in; register additional providers at startup:

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import {
  ProviderRegistry,
  registerBuiltInProviders,
  configureProviderRegistry,
} from '@mcai/orchestrator';

const providers = new ProviderRegistry();
registerBuiltInProviders(providers);

// Groq (OpenAI-compatible API)
const groq = createOpenAI({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY!,
});
providers.register('groq', {
  createLanguageModel: (modelId) => groq(modelId),
  modelPrefixes: ['llama-', 'mixtral-', 'gemma-'],
});

// Ollama (local, no API key)
const ollama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
});
providers.register('ollama', {
  createLanguageModel: (modelId) => ollama(modelId),
});

configureProviderRegistry(providers);
```

Agents can then use `provider: 'groq'` or `provider: 'ollama'` in their config. The registry also supports prefix-based provider inference — a model named `llama-3-70b` auto-resolves to the `groq` provider when `provider` is omitted.

### Streaming

Use `stream()` for real-time event consumption, including token-by-token LLM output:

```typescript
import { GraphRunner, isTerminalEvent } from '@mcai/orchestrator';
import type { StreamEvent } from '@mcai/orchestrator';

const runner = new GraphRunner(graph, state, opts);

for await (const event of runner.stream()) {
  switch (event.type) {
    case 'agent:token_delta':
      process.stdout.write(event.token);  // real-time tokens
      break;
    case 'node:complete':
      console.log(`${event.node_id} done in ${event.duration_ms}ms`);
      break;
    case 'workflow:complete':
      console.log('Done:', event.state.status);
      break;
  }
}
```

`stream()` is the canonical execution path — `run()` consumes it internally. Terminal events (`workflow:complete`, `workflow:failed`, `workflow:timeout`, `workflow:waiting`) carry the full `WorkflowState`. Use `isTerminalEvent()` to narrow.

See [examples/](./examples/) for complete, runnable versions.

## Features

| Category | Highlights |
|----------|-----------|
| **Graph Engine** | Cyclic graphs, 10 node types, conditional routing via [filtrex](https://github.com/joewalnes/filtrex), parallel fan-out/fan-in |
| **Node Types** | `agent` `tool` `router` `supervisor` `approval` `map` `synthesizer` `voting` `subgraph` `evolution` |
| **Resilience** | Retry with backoff (linear/exponential/fixed), circuit breakers, saga rollback, durable execution via event sourcing |
| **Security** | Zero Trust state slicing (`read_keys`/`write_keys`), taint tracking for external data, permission-enforced reducers |
| **Streaming** | `stream()` async generator, real-time token deltas, typed `StreamEvent` union, `isTerminalEvent()` guard, `AbortSignal` cancellation |
| **Observability** | 14 lifecycle events, OpenTelemetry tracing (opt-in), Prometheus metrics, token streaming |
| **Cost Control** | Token budgets, per-run cost tracking, workflow and node-level timeouts |

## Examples

| Example | Pattern | What It Shows |
|---------|---------|---------------|
| [research-and-write](./examples/research-and-write/) | Linear | 2-node pipeline with state slicing |
| [supervisor-routing](./examples/supervisor-routing/) | Supervisor | LLM-powered dynamic routing between specialists |
| [human-in-the-loop](./examples/human-in-the-loop/) | Approval Gate | Pause for human review, then continue |
| [map-reduce](./examples/map-reduce/) | Map-Reduce | Fan-out to parallel workers, synthesize results |
| [eval-loop](./examples/eval-loop/) | Conditional Cycle | Iterative refinement with quality gate via conditional edges |
| [streaming](./examples/streaming/) | Streaming | Real-time event streaming with token-by-token output via `stream()` |

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/<example-name>/<example-name>.ts
```

## Documentation

- **[Examples](./examples/)** — Runnable workflow examples with full source
- **[CONTRIBUTING](https://gitlab.com/wmcmahan/mc-ai/blob/main/CONTRIBUTING.md)** — Development setup, coding standards, PR guidelines

## Project Structure

```
src/
  agent/          Agent factory, provider registry, executor, supervisor, evaluator
  architect/      Natural language → graph generation
  db/             Event log writers (in-memory, no-op)
  evals/          Eval framework (assertions, runner)
  mcp/            MCP gateway client and tool adapter
  persistence/    Persistence interfaces + in-memory implementations
  reducers/       Pure state reducer functions
  runner/         GraphRunner, node executors, circuit breaker
  types/          Graph, State, Action, Event (Zod schemas)
  utils/          Logger, tracing, metrics, taint, pricing
  validation/     Graph structure validation
  index.ts        Public API barrel export
```

## Contributing

See [CONTRIBUTING.md](https://gitlab.com/wmcmahan/mc-ai/blob/main/CONTRIBUTING.md).

## License

[Apache 2.0](./LICENSE)
