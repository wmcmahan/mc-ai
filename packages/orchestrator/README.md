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
git clone https://github.com/wmcmahan/mc-ai.git
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
  createProviderRegistry,
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
  tools: [{ type: 'builtin', name: 'save_to_memory' }],
  read_keys: ['goal'],
  write_keys: ['draft'],
});
configureAgentFactory(registry);

// 2. Configure LLM providers (OpenAI + Anthropic are built-in)
const providers = createProviderRegistry();
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

Agents can then use `provider: 'groq'` or `provider: 'ollama'` in their config. The registry also supports provider inference — a model in the provider's known model list auto-resolves to that provider when `provider` is omitted. Use `addModel()` to register new model names at runtime.

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
- **[CONTRIBUTING](https://github.com/wmcmahan/mc-ai/blob/main/CONTRIBUTING.md)** — Development setup, coding standards, PR guidelines

## Project Structure

```
src/
  agent/          Agent factory, provider registry, executor, supervisor, evaluator
  architect/      Natural language → graph generation
  db/             Event log writers (in-memory, no-op)
  evals/          Eval framework (assertions, runner)
  mcp/            MCP connection manager, tool adapter, gateway client
  persistence/    Persistence interfaces + in-memory implementations
  reducers/       Pure state reducer functions
  runner/         GraphRunner, node executors, circuit breaker
  types/          Graph, State, Action, Event (Zod schemas)
  utils/          Logger, tracing, metrics, taint, pricing
  validation/     Graph structure validation
  index.ts        Public API barrel export
```

## Security Model

The engine enforces a Zero Trust security model: agents are untrusted by default and receive only what they need.

### State View Filtering

Each node declares `read_keys` and `write_keys`. Before execution, the engine slices `WorkflowState.memory` so the agent only sees permitted keys:

```typescript
{ id: 'writer', type: 'agent', agent_id: '...', read_keys: ['draft', 'outline'], write_keys: ['draft'] }
```

- `['*']` grants access to all non-internal keys
- Dot-notation paths (e.g. `'user.name'`) filter nested objects
- Keys starting with `_` are **always** blocked regardless of permissions — these are reserved for internal bookkeeping (taint registry, etc.)

### Taint Tracking

Data originating from external tools (web search, browser, MCP tools) is automatically tagged in `memory._taint_registry`. This tracks which keys contain potentially untrusted content and their provenance (source tool, timestamp).

- **Default behavior**: Tainted keys used in conditional edge routing produce a warning log
- **Strict mode**: Set `strict_taint: true` on the graph to reject routing decisions based on tainted data entirely
- Tainted data in supervisor routing inputs triggers an explicit warning in the supervisor's prompt

### Permission-Enforced Reducers

The reducer validates every state mutation against the acting node's `write_keys`:

- `update_memory` payloads are checked key-by-key against the node's allowed writes
- `_`-prefixed keys are rejected even with `write_keys: ['*']`
- `merge_parallel_results` payloads follow the same rules

### Prompt Injection Sanitization

Agent inputs pass through sanitizers that:

- Apply NFKC Unicode normalization (catches Cyrillic homograph attacks)
- Strip carriage returns and normalize consecutive newlines
- Remove Unicode directional overrides (`U+202A`–`U+202E`, `U+2066`–`U+2069`)
- Detect base64-encoded injection phrases

## Error Handling & Recovery

### Retry with Backoff

Each node can define a `failure_policy`:

```typescript
failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 30000 }
```

Strategies: `fixed`, `linear`, `exponential`. The runner retries the node up to `max_retries` times before marking it as failed.

### Circuit Breaker

The circuit breaker tracks failure rates per node and transitions through `closed → open → half_open` states. When open, the node is skipped with a `CircuitBreakerOpenError`. Configurable thresholds and reset timeouts.

### Compensation / Rollback

Nodes with `requires_compensation: true` push a compensation action onto `WorkflowState.compensation_stack`. On failure:

- **`auto_rollback: true`** (GraphRunner option): Executes LIFO compensation actions automatically, setting status to `cancelled`
- **`auto_rollback: false`** (default): Compensation stack is preserved but not executed — the host application decides

### Workflow Timeouts

Two timeout levels:

- **Workflow-level**: `max_execution_time_ms` on WorkflowState. Checked between nodes and via `Promise.race` during node execution
- **Node-level**: `timeout_ms` on individual nodes. Enforced per-execution

When the workflow timeout fires during node execution, the `AbortSignal` is triggered and a `WorkflowTimeoutError` is thrown.

### Approval Gate Timeouts

Approval nodes with `timeout_ms` set a `waiting_timeout_at` deadline. If the workflow is resumed after the deadline expires, it transitions to `timeout` status immediately.

### Event Log Failure Policy

The `EventLogWriter` is append-only and errors propagate to the runner. Failed event appends increment the runner's internal failure counter. The runner does **not** silently swallow persistence errors — they surface to the caller's error handling.

### Graceful Shutdown

Call `runner.shutdown()` to signal the engine to stop after the current node completes. The workflow remains in `running` status (resumable) and emits a `workflow:paused` event.

## Contributing

See [CONTRIBUTING.md](https://github.com/wmcmahan/mc-ai/blob/main/CONTRIBUTING.md).

## License

[Apache 2.0](./LICENSE)
