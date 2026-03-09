# MC-AI

**Agentic orchestration built on a Cyclic State Graph architecture.**

MC-AI is a workflow engine for complex, multi-step AI agent systems. It provides patterns for Supervisors, Map-Reduce, Evolution, Human-in-the-Loop, and more — all driven by config, not code.

**No infrastructure required.** The core orchestrator runs standalone with in-memory state. Postgres and Docker are optional — only needed if you use the `@mcai/orchestrator-postgres` persistence adapter.

## Key Features

- **Graph-Based Orchestration** — Define workflows as cyclic or acyclic graphs with typed nodes and edges
- **Config-Driven Agents** — Agents are JSON configs, not classes. Define model, prompt, tools, and permissions declaratively
- **Reducer-Based State** — Shared blackboard state with pure reducer functions. No direct mutation, no race conditions
- **10 Node Types** — `agent` `tool` `router` `supervisor` `approval` `map` `synthesizer` `voting` `subgraph` `evolution`
- **Supervisor Pattern** — LLM-powered dynamic routing across managed nodes
- **Human-in-the-Loop** — Approval nodes that persist state and resume on human input
- **Subgraph Composition** — Nest graphs within graphs with cycle detection
- **Evolution (DGM)** — Population-based Darwinian selection with fitness evaluation
- **Streaming** — `AsyncGenerator`-based event streaming for real-time UIs and observability
- **Resilience** — Retry with backoff, circuit breakers, saga rollback, durable execution
- **Budget Controls** — Token and cost limits per workflow run
- **Taint Tracking** — External data flagged and tracked through the pipeline
- **OpenTelemetry** — Opt-in distributed tracing across the full execution tree

## Quick Start

### Prerequisites

- Node.js v22+
- An API key: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

### Setup

```bash
git clone https://gitlab.com/wmcmahan/mc-ai.git
cd mc-ai
npm install
```

### Run an Example

```bash
cd packages/orchestrator

# 2-node linear: Researcher → Writer
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts

# Supervisor routing between specialists
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts

# Map-Reduce fan-out with parallel workers
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/map-reduce/map-reduce.ts

# Human-in-the-loop approval gate
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/human-in-the-loop/human-in-the-loop.ts
```

See [packages/orchestrator/examples/](packages/orchestrator/examples/) for the full list.

### Programmatic Usage

```typescript
import { GraphRunner } from '@mcai/orchestrator';

const runner = new GraphRunner(graph, initialState, {
  persistStateFn: async (state) => { /* save state */ },
});

// Run to completion
const finalState = await runner.run();

// Or stream events for real-time UIs
for await (const event of runner.stream()) {
  console.log(event.type, event);
}
```

### Test

```bash
npm test
```

## Project Structure

```
packages/
  orchestrator/              Core graph engine (@mcai/orchestrator) — zero infra dependencies
  orchestrator-postgres/     Postgres persistence adapter (@mcai/orchestrator-postgres) — optional
```

## Optional: Postgres Persistence

Only needed if you want durable state, event logs, or vector search via `@mcai/orchestrator-postgres`.

```bash
# Start Postgres
docker-compose up -d

# Copy env and add your API keys
cp .env.example .env

# Run database migrations
npm run db:migrate
```

## Documentation

See [`packages/orchestrator/README.md`](packages/orchestrator/README.md) for the full API reference, streaming guide, and custom provider setup.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and PR guidelines.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md). Do not open public issues for security concerns.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

See [LICENSE](LICENSE) for the full text.
