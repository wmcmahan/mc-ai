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

// 1. Register an agent (agents are config, not classes — ID is auto-generated)
const registry = new InMemoryAgentRegistry();
const agentId = registry.register({
  name: 'Writer',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'Write a summary. Save it with save_to_memory key "draft".',
  temperature: 0.7,
  max_steps: 3,
  tools: [{ type: 'builtin', name: 'save_to_memory' }],
  permissions: { read_keys: ['goal'], write_keys: ['draft'] },
});
configureAgentFactory(registry);

// 2. Configure LLM providers (OpenAI + Anthropic are built-in)
const providers = createProviderRegistry();
configureProviderRegistry(providers);

// 3. Define a graph (version/created_at/updated_at are persistence-layer concerns)
const graph: Graph = {
  id: uuidv4(),
  name: 'Simple',
  description: 'Single-node writer workflow',
  nodes: [{ id: 'write', type: 'agent', agent_id: agentId, read_keys: ['goal'], write_keys: ['draft'] }],
  edges: [],
  start_node: 'write',
  end_nodes: ['write'],
};

// 4. Run (use createWorkflowState — only workflow_id and goal are required)
import { createWorkflowState } from '@mcai/orchestrator';

const state = createWorkflowState({
  workflow_id: graph.id,
  goal: 'Explain how transformers work',
});

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
| **Resilience** | Retry with backoff (linear/exponential/fixed), circuit breakers, typed saga rollback, durable execution via event sourcing, event log auto-compaction |
| **Security** | Zero Trust state slicing (`read_keys`/`write_keys`), taint tracking for external data, permission-enforced reducers |
| **Streaming** | `stream()` async generator, real-time token deltas, tool call start/finish events, memory diffs on `action:applied`, typed `StreamEvent` union, `isTerminalEvent()` guard, `AbortSignal` cancellation |
| **MCP Tools** | Tool manifest caching (5-min TTL), per-tool execution timeouts, connection retry with backoff, auto-reconnect |
| **Observability** | 17 lifecycle events, OpenTelemetry tracing (opt-in), Prometheus metrics, token and tool call streaming |
| **Cost Control** | Token budgets, per-run cost tracking, budget-aware model resolution (all node types), workflow and node-level timeouts |
| **Context Compression** | Optional `@mcai/context-engine` integration — format compression, dedup, CoT distillation, heuristic pruning with `context:compressed` stream events |
| **Distributed Execution** | `WorkflowWorker` with per-workflow assignment, `WorkflowQueue` interface, visibility-timeout crash recovery, HITL pause (`paused` status — not re-claimable), dead-lettering, configurable concurrency |
| **Persistence** | Mandatory atomic snapshots, differential state persistence (delta tracking), event log auto-compaction |

## Context Compression (Optional)

Reduce token costs by 40-70% on agent memory payloads. Pass a `contextCompressor` to `GraphRunnerOptions` — the orchestrator uses it to compress memory before injecting into agent and supervisor prompts.

```typescript
import { GraphRunner } from '@mcai/orchestrator';
import type { ContextCompressor } from '@mcai/orchestrator';
import { createOptimizedPipeline, serialize } from '@mcai/context-engine';

const { pipeline } = createOptimizedPipeline({ preset: 'balanced' });

const contextCompressor: ContextCompressor = (sanitizedMemory, options) => {
  const result = pipeline.compress({
    segments: [{ id: 'memory', content: serialize(sanitizedMemory), role: 'memory', priority: 1 }],
    budget: { maxTokens: options?.maxTokens ?? 8192, outputReserve: 0 },
    model: options?.model,
  });
  return { compressed: result.segments[0].content, metrics: result.metrics };
};

const runner = new GraphRunner(graph, state, { contextCompressor });
```

Without `@mcai/context-engine` installed, the orchestrator works exactly as before — memory is serialized as `JSON.stringify(data, null, 2)` with a 50KB byte cap.

Compression metrics are emitted as `context:compressed` stream events and can be consumed via `runner.on('context:compressed', ...)` for observability.

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
  persistence/    Persistence interfaces + in-memory implementations (including WorkflowQueue)
  reducers/       Pure state reducer functions
  runner/         GraphRunner, node executors, circuit breaker, WorkflowWorker
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

The `EventLogWriter` is append-only with idempotent appends — duplicate `(run_id, sequence_id)` pairs are silently ignored via `ON CONFLICT DO NOTHING`, making retries after network timeouts safe. Other errors propagate to the runner and increment its internal failure counter.

### Persistence Failure Escalation

The GraphRunner tracks consecutive persistence failures. After 3 consecutive failures, it throws a `PersistenceUnavailableError` rather than continuing with divergent in-memory and storage state. The counter resets on any successful persist call.

### Graceful Shutdown

Call `runner.shutdown()` to signal the engine to stop after the current node completes. The workflow remains in `running` status (resumable) and emits a `workflow:paused` event.

## Contributing

See [CONTRIBUTING.md](https://github.com/wmcmahan/mc-ai/blob/main/CONTRIBUTING.md).

## License

[Apache 2.0](./LICENSE)
