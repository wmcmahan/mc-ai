# @mcai/orchestrator-postgres

PostgreSQL persistence adapter for `@mcai/orchestrator`. Provides durable state, event sourcing, agent registry, usage tracking, and retention management backed by Postgres via Drizzle ORM.

## Install

```bash
npm install @mcai/orchestrator-postgres
```

**Peer dependencies**: `@mcai/orchestrator`, `drizzle-orm`, `postgres`.

## Setup

```bash
# Start Postgres (Docker Compose provided at repo root)
docker-compose up -d

# Set connection string
export DATABASE_URL=postgres://mcai:mcai@localhost:5433/mcai

# Run migrations
npm run db:migrate
```

## Usage

```typescript
import {
  DrizzlePersistenceProvider,
  DrizzleEventLogWriter,
  DrizzleAgentRegistry,
  DrizzleUsageRecorder,
  DrizzleRetentionService,
} from '@mcai/orchestrator-postgres';
import { GraphRunner } from '@mcai/orchestrator';

const persistence = new DrizzlePersistenceProvider();
const eventLog = new DrizzleEventLogWriter();
const agentRegistry = new DrizzleAgentRegistry();

// Register an agent
const agentId = await agentRegistry.register({
  name: 'Writer',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'You are a writer.',
  tools: [{ type: 'builtin', name: 'save_to_memory' }],
  permissions: { read_keys: ['*'], write_keys: ['draft'] },
});

// Run a workflow with Postgres persistence
const runner = new GraphRunner(graph, state, {
  persistStateFn: async (s) => { await persistence.saveWorkflowState(s); },
  eventLogWriter: eventLog,
});

const result = await runner.run();
```

## Components

| Class | Implements | Purpose |
|-------|-----------|---------|
| `DrizzlePersistenceProvider` | `PersistenceProvider` | Graph, workflow run, and state CRUD with versioned snapshots |
| `DrizzleEventLogWriter` | `EventLogWriter` | Append-only event log, checkpoints, compaction |
| `DrizzleAgentRegistry` | `AgentRegistry` | Agent config CRUD (register, load, update, list, delete) |
| `DrizzleUsageRecorder` | `UsageRecorder` | Per-run token and cost tracking |
| `DrizzleRetentionService` | `RetentionService` | Tiered archival (hot/warm/cold) with transactional safety |

## Schema

Tables are defined in `src/schema.ts` and managed via Drizzle migrations in `drizzle/`.

| Table | Purpose |
|-------|---------|
| `graphs` | Reusable graph definitions |
| `workflow_runs` | Execution run metadata |
| `workflow_states` | Versioned state snapshots (ordered by `version`, not timestamp) |
| `workflow_events` | Append-only event log with sequence IDs and unique constraints |
| `workflow_checkpoints` | State snapshots for event log compaction |
| `agents` | Agent configuration registry (includes `provider_options` JSONB column) |
| `usage_records` | Token and cost tracking per run |

### Migrations

```bash
# Generate a migration after editing schema.ts
npx drizzle-kit generate --config=packages/orchestrator-postgres/drizzle.config.ts

# Apply migrations
npm run db:migrate

# Push schema directly (dev only)
npx drizzle-kit push --config=packages/orchestrator-postgres/drizzle.config.ts
```

## Error Contracts

- **Event log writes propagate errors** — failed appends (other than duplicate conflicts) are not silently swallowed. The caller (GraphRunner) receives the error and increments its failure counter.
- **Atomic snapshots** — `DrizzlePersistenceProvider.saveWorkflowSnapshot()` wraps both run and state saves in a single database transaction, preventing inconsistent state if one write fails.
- **State versioning** — `loadLatestWorkflowState` sorts by `version` (not `created_at`) to handle sub-millisecond state saves correctly.
- **Transactional archival** — `archiveCompletedWorkflows` wraps its two-phase update (run status + state status) in a database transaction. If either fails, both roll back.
- **Idempotent event append** — appending an event with a duplicate `(run_id, sequence_id)` is silently ignored via `ON CONFLICT DO NOTHING`. This makes retries after network timeouts safe without risking duplicate events.

## Testing

Tests require a running Postgres instance. They are automatically skipped when `DATABASE_URL` is not set.

```bash
# Start Postgres
docker-compose up -d

# Run tests
DATABASE_URL=postgres://mcai:mcai@localhost:5433/mcai npm run test --workspace=packages/orchestrator-postgres
```

## License

[Apache 2.0](./LICENSE)
