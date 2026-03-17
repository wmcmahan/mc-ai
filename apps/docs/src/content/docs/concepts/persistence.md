---
title: Persistence
description: Storage interfaces for graphs, workflow state, event logs, usage records, and data retention.
---

The orchestrator depends only on **interfaces** for storage — concrete implementations are injected at startup. This means you can run entirely in-memory for development and testing, then swap in Postgres (or any other backend) for production without changing application code.

## Architecture

```
@mcai/orchestrator (interfaces + in-memory implementations)
        │
        └── @mcai/orchestrator-postgres (Drizzle/Postgres implementations)
```

The core `@mcai/orchestrator` package has **zero database dependencies**. All persistence contracts are defined as TypeScript interfaces in `persistence/interfaces.ts`, with in-memory implementations provided for development and testing.

## Interfaces

### PersistenceProvider

The primary storage interface. Covers graph definitions, workflow runs, state snapshots, and event queries.

| Method | Description |
|--------|-------------|
| `saveGraph(graph)` | Save or upsert a graph definition. |
| `loadGraph(id)` | Load a graph by ID. |
| `listGraphs(opts?)` | List graphs, ordered by last update. |
| `saveWorkflowRun(state)` | Save or upsert a run record from current state. |
| `loadWorkflowRun(id)` | Load a run by ID. |
| `listWorkflowRuns(opts?)` | List runs, ordered by creation time. |
| `updateRunStatus(id, status)` | Update only the status of a run. |
| `saveWorkflowState(state)` | Save a state snapshot (auto-incremented version). |
| `loadLatestWorkflowState(run_id)` | Load the most recent state for crash recovery. |
| `loadWorkflowStateHistory(run_id, opts?)` | Load version history (lightweight summaries). |
| `loadWorkflowStateAtVersion(run_id, version)` | Load full state at a specific version. |
| `loadEvents(run_id)` | Load raw event rows for a run. |

### AgentRegistry

Stores and retrieves agent configurations. The `register()` method auto-generates UUIDs:

| Method | Description |
|--------|-------------|
| `register(input)` | Register an agent config (`AgentRegistryInput`, no `id` field). Returns the auto-generated UUID. |
| `loadAgent(id)` | Load an agent config by ID. Returns `null` if not found. |

Both `InMemoryAgentRegistry` and `DrizzleAgentRegistry` implement the full `AgentRegistry` interface, including `register()`.

### MCPServerRegistry

Trusted store for MCP server transport configurations. See [Tools & MCP](/concepts/tools-and-mcp/) for details.

| Method | Description |
|--------|-------------|
| `saveServer(entry)` | Register or update a server entry. |
| `loadServer(id)` | Load a server by ID. |
| `listServers()` | List all registered servers. |
| `deleteServer(id)` | Remove a server. |

### UsageRecorder

Persists per-run cost and token usage for billing and observability:

| Method | Description |
|--------|-------------|
| `saveUsageRecord(record)` | Persist a usage record (run_id, tokens, cost, duration). |

### RetentionService

Manages workflow data lifecycle across Hot / Warm / Cold tiers:

| Method | Description |
|--------|-------------|
| `archiveCompletedWorkflows()` | Move completed runs from Hot to Warm tier. |
| `deleteWarmData()` | Delete Warm data older than the retention period. |
| `getStorageStats()` | Get per-tier run counts. |

## In-memory implementations

For development and testing, the core package provides:

- `InMemoryPersistenceProvider` — full `PersistenceProvider` backed by `Map` objects
- `InMemoryAgentRegistry` — agent registry with `register()` and `loadAgent()`
- `InMemoryMCPServerRegistry` — MCP server registry backed by a `Map`

```typescript
import {
  InMemoryPersistenceProvider,
  InMemoryAgentRegistry,
  InMemoryMCPServerRegistry,
} from '@mcai/orchestrator';

const persistence = new InMemoryPersistenceProvider();
const agents = new InMemoryAgentRegistry();
const mcpServers = new InMemoryMCPServerRegistry();
```

## Postgres implementation

The `@mcai/orchestrator-postgres` package provides production-grade Drizzle ORM implementations:

- `DrizzlePersistenceProvider`
- `DrizzleAgentRegistry`
- `DrizzleMCPServerRegistry`
- `DrizzleEventLogWriter`
- `DrizzleUsageRecorder`
- `DrizzleRetentionService`

```typescript
import { DrizzlePersistenceProvider, DrizzleAgentRegistry } from '@mcai/orchestrator-postgres';
```

## Wiring persistence into the runner

The `GraphRunner` accepts a `persistStateFn` callback that is called after every state mutation:

```typescript
const runner = new GraphRunner(graph, state, {
  persistStateFn: async (state) => {
    await persistence.saveWorkflowState(state);
    await persistence.saveWorkflowRun(state);
  },
});
```

## State versioning

Every call to `saveWorkflowState()` creates a new version. This enables:

- **Crash recovery** — `loadLatestWorkflowState()` returns the most recent snapshot
- **State history** — `loadWorkflowStateHistory()` lists all versions for debugging
- **Time travel** — `loadWorkflowStateAtVersion()` loads full state at any version

`loadLatestWorkflowState()` sorts by `version` (not `created_at`) to handle sub-millisecond state saves correctly. Multiple state saves within the same millisecond are common during parallel node execution, so version ordering is the only reliable way to identify the latest state.

## Next steps

- [Workflow State](/concepts/workflow-state/) — the state object that gets persisted
- [Cost & Budget Tracking](/concepts/cost-tracking/) — usage recording interface
- [Error Handling](/concepts/error-handling/) — crash recovery and event replay
