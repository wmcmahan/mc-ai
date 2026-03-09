---
title: Introduction
description: What MC-AI is, why it exists, and how it differs from other orchestration frameworks.
---

MC-AI is an **agentic orchestration engine** built on a Cyclic State Graph architecture. It enables complex, multi-step AI workflows with patterns including Supervisors, Evolution (DGM), Self-Annealing loops, Swarms, Human-in-the-Loop, and Map-Reduce.

## What makes MC-AI different

Most AI orchestration frameworks model workflows as linear chains or strict DAGs — agent A calls agent B, which calls agent C. This works for simple pipelines, but breaks down when you need:

- An agent to **loop back** and self-correct based on feedback
- A supervisor to **dynamically route** work without a predetermined path
- Multiple candidate solutions to **evolve in parallel** across generations
- A workflow to **pause for human review** and resume hours later

MC-AI is built around a **Cyclic State Graph** — a graph where nodes can loop, revisit previous nodes, and make runtime decisions based on shared state. This enables patterns that are difficult or impossible to express in chain-based systems.

## Core mental model

Everything in MC-AI revolves around four concepts:

| Concept | What it is |
|---------|-----------| 
| **Graph** | The workflow definition — a set of nodes connected by edges |
| **Node** | A unit of work: an Agent, a Tool, a Supervisor, or a Subgraph |
| **State** | A shared blackboard that all nodes read from and write to |
| **Reducer** | A pure function `(State, Action) → NewState` — the only way state changes |

Agents never communicate directly with each other. They read from the shared state, do work, and emit actions. Reducers apply those actions to produce a new state. This design eliminates race conditions and makes every state transition auditable.

## What MC-AI is not

- **Not a chatbot framework** — MC-AI is a workflow engine, not a conversational AI system
- **Not a simple chain library** — it supports complex routing, cycles, and parallel execution
- **Not a low-code tool** — workflows are defined in TypeScript with full type safety

## Architecture overview

```
GraphRunner.run() / GraphRunner.stream()
        │
        ├─── Evaluate Start Node
        │
        ├─── Execute Node ──┬── Agent Node ──── LLM + Tools
        │                   ├── Supervisor ──── Route Decision
        │                   ├── Map Node ────── Parallel Fan-Out
        │                   └── Subgraph ────── Nested Graph
        │
        ├─── Apply Reducer → New State → Persist
        │
        ├─── Evaluate Edge Conditions → Next Node
        │
        └─── Repeat until end_node or __done__
```

The `GraphRunner` is a library — embed it directly in your application. For background processing, pair it with any job queue (BullMQ, SQS, etc.).

## Next steps

- [Install MC-AI](/getting-started/installation/) and run your first example
- [Quick Start](/getting-started/quick-start/) — run a workflow in under 5 minutes
- [Core Concepts](/concepts/overview/) — understand the graph model before diving into code
