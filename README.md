# MC-AI

**Agentic orchestration built on a Cyclic State Graph architecture.**

MC-AI is a production-ready workflow engine for building complex, multi-step AI agent systems. It provides robust patterns for Supervisors, Map-Reduce, Evolution (DGM), Human-in-the-Loop, and Swarms — all driven by configuration, not hardcoded chains.

[📚 **Read the full documentation here** →](https://mc-ai-docs.vercel.app)

---

## Why MC-AI?

Most AI orchestration frameworks model workflows as linear chains or strict Directed Acyclic Graphs (DAGs). This works for simple pipelines, but falls apart when you need an agent to loop back and self-correct, a supervisor to dynamically route work, or a workflow to pause for human approval.

MC-AI uses a **Cyclic State Graph**. Nodes can loop, revisit previous steps, and make runtime decisions based on a shared state blackboard. Agents never communicate directly — they emit actions that are applied via pure reducer functions, eliminating race conditions and making every state transition fully auditable.

## Key Features

- **Graph-Based Orchestration** — Define workflows as cyclic or acyclic graphs with typed nodes and edges.
- **Advanced Patterns out-of-the-box** — Built-in support for Supervisors, Swarms, Map-Reduce, and population-based Darwinian Evolution.
- **Human-in-the-Loop** — Approval nodes that securely persist workflow state and resume exactly where they left off upon human input.
- **Built for Production** — Includes native retry backoffs, circuit breakers, saga rollbacks, and durable execution capabilities.
- **Enterprise Security** — Zero Trust architecture with taint tracking to flag and sandbox external data throughout the execution pipeline.
- **Zero Required Infrastructure** — The core orchestrator is a lightweight TypeScript library with in-memory execution. PostgreSQL is entirely optional.

## Quick Start

### 1. Install

```bash
npm install @mcai/orchestrator
```

### 2. Run a built-in example

You can run any of our built-in pattern examples instantly using `npx tsx` and an Anthropic API key.

```bash
# Clone the repository to access the examples
git clone https://github.com/wmcmahan/mc-ai.git
cd mc-ai
npm install

# Run a Supervisor routing between specialists
ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/orchestrator/examples/supervisor-routing/supervisor-routing.ts

# Run a Map-Reduce fan-out with parallel workers
ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/orchestrator/examples/map-reduce/map-reduce.ts
```

*See the [Getting Started Guide](https://github.com/wmcmahan/mc-ai/tree/main/apps/docs/src/content/docs/getting-started/quick-start.md) for a complete walkthrough of building your own workflow from scratch.*

## Project Structure

This monorepo contains the following packages:

- `packages/orchestrator`: The core graph engine (`@mcai/orchestrator`) with zero infrastructure dependencies.
- `packages/orchestrator-postgres`: An optional persistence adapter (`@mcai/orchestrator-postgres`) for durable state, event sourcing, and vector search.
- `apps/docs`: The official Starlight documentation site.
- `apps/api`: The Fastify gateway and server runtime.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup instructions, coding standards, and PR guidelines.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
