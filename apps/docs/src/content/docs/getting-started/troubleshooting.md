---
title: Troubleshooting
description: Common first-run errors when setting up cycgraph, with concrete fixes.
---

This page covers the errors most people hit on their first runs. Each entry shows the symptom, what it means, and the fix.

## Missing or invalid LLM API key

**Symptom:** the workflow starts, the first agent node executes, and you get a 401 / `Authentication` / `Invalid API key` error from the AI SDK.

**Cause:** the provider's API key is not set in the environment, or the agent's `provider` field doesn't match a key you've set.

**Fix:**

```bash
# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# OpenAI
export OPENAI_API_KEY="sk-..."
```

Verify the agent's `provider` field matches the key you exported. The Vercel AI SDK reads keys from environment variables matching the provider name.

## `AgentNotFoundError: agent <id> not found`

**Symptom:** the runner throws `AgentNotFoundError` the moment it tries to execute the first agent node.

**Cause:** the registry that holds your agent configs has not been wired into the global agent factory. Without `configureAgentFactory()`, the runner has no way to look up an agent by ID.

**Fix:** call `configureAgentFactory()` once at startup, after registering all agents:

```typescript
import { InMemoryAgentRegistry, configureAgentFactory } from '@cycgraph/orchestrator';

const registry = new InMemoryAgentRegistry();
const writerId = registry.register({ /* ... */ });

configureAgentFactory(registry); // ← required before any runner.run()
```

## `UnsupportedProviderError: provider <name> not registered`

**Symptom:** thrown during agent execution, naming a provider like `'anthropic'` or `'openai'`.

**Cause:** the provider registry is empty or hasn't been wired globally. By default, `createProviderRegistry()` includes the built-in Anthropic and OpenAI factories — but you still need to install the SDK packages and pass the registry to `configureProviderRegistry()`.

**Fix:**

```bash
npm install @ai-sdk/anthropic   # or @ai-sdk/openai
```

```typescript
import { createProviderRegistry, configureProviderRegistry } from '@cycgraph/orchestrator';

const providers = createProviderRegistry();
configureProviderRegistry(providers); // ← required before any runner.run()
```

For non-built-in providers (Groq, Ollama, etc.), see [Custom LLM Providers](/guides/custom-providers/).

## `PermissionDeniedError: agent attempted to write to <key>`

**Symptom:** the agent's LLM call completes, but the runner immediately rejects its output with `PermissionDeniedError`.

**Cause:** the agent wrote to a memory key that isn't in its `write_keys`. The agent executor enforces `write_keys` strictly — if the key isn't listed, the write is rejected. The default for `write_keys` is **deny-all** (empty array).

**Fix:** add the key to the agent's `permissions.write_keys`:

```typescript
registry.register({
  /* ... */
  permissions: {
    read_keys: ['goal'],
    write_keys: ['draft'], // ← every key the agent will write must be listed
  },
});
```

If the agent writes structured data to multiple keys via `save_to_memory`, list every key it might use. If you're not sure which keys the agent writes, watch a run with `runner.on('node:failed', ...)` — the error message includes the rejected key name.

## `MCPServerNotFoundError: server <id> not in registry`

**Symptom:** thrown the first time an agent with an `mcp`-typed tool tries to resolve its tools.

**Cause:** the agent references a `server_id` that doesn't exist in the MCP server registry, or the registry wasn't initialized before the runner started.

**Fix:** register the server in the MCP registry, then pass the registry-backed `MCPConnectionManager` as `toolResolver`:

```typescript
import {
  InMemoryMCPServerRegistry,
  registerDefaultMCPServers,
  MCPConnectionManager,
  GraphRunner,
} from '@cycgraph/orchestrator';

const mcpRegistry = new InMemoryMCPServerRegistry();
await registerDefaultMCPServers(mcpRegistry); // registers `web-search` and `fetch`

const toolResolver = new MCPConnectionManager(mcpRegistry);
const runner = new GraphRunner(graph, state, { toolResolver });
```

For custom servers, see [Adding MCP Tools](/guides/adding-tools/).

## `MCPAccessDeniedError: agent <id> not allowed for server <id>`

**Symptom:** the runner rejects an agent's MCP tool resolution, naming the server.

**Cause:** the server has an `allowed_agents` list, and the requesting agent's ID is not on it.

**Fix:** either add the agent to the server's `allowed_agents`, or remove the restriction if it isn't needed:

```typescript
await mcpRegistry.saveServer({
  id: 'web-search',
  name: 'Web Search',
  transport: { /* ... */ },
  allowed_agents: ['researcher-id', 'analyst-id'], // ← include every agent that needs access
});
```

## `mcp_source_skipped_no_resolver` (warning, not error)

**Symptom:** the workflow runs without crashing, but agents that should be using MCP tools behave like they have none. The logs include `mcp_source_skipped_no_resolver` warnings.

**Cause:** no `toolResolver` is configured on the runner. Without one, the engine resolves built-in tools only and silently skips MCP sources.

**Fix:** pass an `MCPConnectionManager` (or any `ToolResolver` implementation) as `toolResolver`:

```typescript
const runner = new GraphRunner(graph, state, {
  toolResolver: new MCPConnectionManager(mcpRegistry),
});
```

## MCP stdio command rejected

**Symptom:** registering an MCP server with a stdio transport fails, naming a command like `bash` or `sh`.

**Cause:** the stdio transport allowlists only safe runners. As of this release: `npx`, `node`, `python3`, `python`, `uvx`. Arbitrary shell commands are blocked.

**Fix:** rewrap your server's launch command behind one of the allowed runners (most MCP servers ship as `npx <package>` or `uvx <package>` already).

## Graph fails Zod validation at load

**Symptom:** `createGraph()` throws a `ZodError` listing fields like `nodes`, `edges`, `start_node`, or specific node-config blocks.

**Cause:** the input doesn't match `GraphSchema`. Common offenders:

- Edges declared as `{ from, to }` instead of `{ source, target }`.
- Edge `condition` declared as a string (`'memory.x > 0'`) instead of an `EdgeCondition` object (`{ type: 'conditional', condition: 'memory.x > 0' }`).
- Missing `description` (it's required, not optional).
- Setting persistence-only fields like `version`, `created_at`, `updated_at` on the input — these are managed by the persistence layer, not the schema.
- Tool source declared as `{ type: 'mcp', name: 'github' }` instead of `{ type: 'mcp', server_id: 'github' }`.

**Fix:** read the Zod error path — it points at the offending field. See [Graphs](/concepts/graphs/) for the canonical schema.

## Workflow halts with no progress (max iterations reached)

**Symptom:** the workflow ends with status `failed` and a `max_iterations_reached` log warning, even though no node threw.

**Cause:** a cyclic graph (supervisor, swarm, self-annealing loop) has spun past `state.max_iterations` (default: 50). This is a circuit breaker, not a real failure.

**Fix:** raise `max_iterations` in the initial state if the workload genuinely needs more cycles, or tighten the loop's exit condition (supervisor `completion_condition`, annealing `threshold`, swarm `max_handoffs`):

```typescript
const state = createWorkflowState({
  workflow_id: graph.id,
  goal: '...',
  max_iterations: 100, // ← override the default of 50
});
```

## `memory:dropped` stream event fires every run

**Symptom:** the runner emits `memory:dropped` events and `state.memory_drops` accumulates entries with `reason: 'oversized'` or `reason: 'non_serializable'`.

**Cause:** an agent is writing a memory value that exceeds `MAX_MEMORY_VALUE_BYTES` (default 1 MB), or it's pushing a value that can't round-trip through `JSON.stringify` (typically a circular reference). The reducer rejects the update and records the drop instead of letting bad state spread.

**Fix:** inspect the dropped key:

```typescript
for (const drop of state.memory_drops) {
  console.log(drop); // { key, reason, bytes?, node_id, timestamp }
}
```

For oversized values, either trim the agent's output (most common: a long tool result the agent returned verbatim) or raise `MAX_MEMORY_VALUE_BYTES`. For non-serializable values, fix the agent — circular references usually mean an object was wrapped without being unwrapped.

## `ToolCircuitBreakerOpenError`: tool is refusing execution

**Symptom:** an MCP tool throws `ToolCircuitBreakerOpenError` repeatedly. The error message includes a `retryAfterMs`.

**Cause:** the per-tool circuit breaker has tripped — the tool has failed `failure_threshold` (default 5) consecutive times. The breaker stays `open` for `cooldown_ms` (default 30s), then transitions to `half_open` for a single probe.

**Fix:** treat this as a signal that the underlying tool is genuinely unhealthy. Inspect the MCP server's logs. The breaker will auto-close once a probe succeeds. To inspect breaker state across all tools:

```typescript
const metrics = mcpManager.getToolCircuitMetrics();
// [{ server_id, tool_name, status, consecutive_failures, ... }]
```

If you need to bypass the breaker for one tool (e.g. you've verified it's healthy), reset it:

```typescript
mcpManager['toolBreakers']?.reset(serverId, toolName); // internal API
```

For deeper details see the [Deployment Guide → Circuit Breakers](/operations/deployment/#circuit-breakers).

## `EmbeddingDimensionMismatchError`: vector size mismatch

**Symptom:** the memory index throws `EmbeddingDimensionMismatchError` with `expected` and `actual` fields when a query is run or the index is rebuilt.

**Cause:** the embeddings stored in the index don't match the dimensionality the index was configured for. This is almost always a misconfiguration after swapping `EmbeddingProvider` (e.g. moving from text-embedding-3-small at 1536 dims to text-embedding-3-small at 512 dims) without re-embedding existing vectors.

**Fix:** either rebuild the embeddings with the new provider, or revert to the previous dimensionality. If you intentionally need to mix dimensions (you probably don't), construct the index without `expectedDimensions` — but you'll silently get incorrect cosine scores.

```typescript
const index = new InMemoryMemoryIndex({
  expectedDimensions: embeddingProvider.dimensions, // ← wire from the provider
});
```

## `Graph validation failed: condition expression has syntax error`

**Symptom:** `validateGraph()` returns `valid: false` with an error like `Edge 'edge-1': condition expression '(((' has syntax error: ...`.

**Cause:** an edge `condition` is a malformed filtrex expression. Previously this was a warning and the broken expression silently evaluated to `false` at runtime — misrouting your workflow. As of Wave 2, it's a hard error at graph load.

**Fix:** check the expression against the filtrex grammar. Common issues:

- Mismatched parentheses (`(((`).
- Using `&&` / `||` instead of `and` / `or`.
- Referencing a function not in the supported set: `length`, `lower`, `upper`, `typeof`, `includes`, `number`.

```typescript
// ❌ wrong
'memory.confidence > 0.8 && length(memory.results) > 0'

// ✅ right
'memory.confidence > 0.8 and length(memory.results) > 0'
```

Single-quoted string literals are accepted (normalized to double quotes internally).

## Postgres save fails with `unique_violation` on workflow_states

**Symptom:** rarely, a save to `workflow_states` fails with Postgres SQLSTATE `23505` on the `uq_workflow_states_run_version` constraint.

**Cause:** two GraphRunner instances raced on `MAX(version)+1` for the same `run_id`. As of Wave 3, the adapter automatically retries this with full-jitter exponential backoff (up to 5 retries). If you still see this error surfacing to your caller, retry exhaustion means the race is persistent — most likely two workers are racing on the same run.

**Fix:** ensure only one runner is active per `run_id` at a time. If you need fan-out, give each worker its own `run_id`.

## Where to look next

If your error isn't here, check:

- [Error Handling](/concepts/error-handling/) — full error class reference and recovery patterns.
- [Configuration Reference](/operations/configuration/) — every tuning knob.
- [Deployment Guide](/operations/deployment/) — production wiring, retention, observability.
- [Security](/security/) — what permissions and budgets actually enforce.
- [Tools & MCP](/concepts/tools-and-mcp/) — MCP transport, registry, and access control.
