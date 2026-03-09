---
title: Workflow State
description: The shared blackboard that all nodes read from and write to.
---

The **WorkflowState** is the shared blackboard at the heart of every workflow. All nodes communicate through it — reading context, writing results, and coordinating behavior.

## Schema

```typescript
interface WorkflowState {
  // Identity
  workflow_id: string;
  run_id: string;

  // Input
  goal: string;
  constraints?: string[];

  // Working memory — shared between all nodes
  memory: Record<string, unknown>;

  // Status and control
  status: 'pending' | 'running' | 'completed' | 'failed' | 'waiting' | 'cancelled';
  iteration_count: number;
  max_iterations: number;
  max_execution_time_ms: number;

  // Resilience
  retry_count: number;
  max_retries: number;
  compensation_stack: CompensationEntry[];
  visited_nodes: string[];

  // Cost tracking
  total_tokens_used?: number;
  total_cost_usd?: number;

  // Timestamps
  created_at: Date;
  updated_at: Date;
}
```

## Memory

The `memory` object is the primary data exchange mechanism. Agents read from it and write to it via the `save_to_memory` tool:

```typescript
memory: {
  topic: "Future of Autonomous Agents",  // set by initial state
  notes: "...",                            // written by researcher agent
  draft: "...",                            // written by writer agent
  review_score: 0.85,                     // written by evaluator agent
}
```

### Best practices

- **Reference, don't store**: Never put large blobs in memory. Store them externally and keep a path/ID reference.
- **Use descriptive keys**: `research_output` is better than `data` or `result`.
- **Typed reducers**: Agents emit proposals (`{ type: 'submit_draft', content: '...' }`). A reducer function merges them safely.

## Memory layers

The system distinguishes between different memory scopes:

| Layer | Scope | Persistence | Purpose |
|-------|-------|-------------|---------|
| **Graph State** | Global (shared) | Persisted (checkpoint) | Source of truth — goal, results, artifacts |
| **Thread Context** | Local (per-node) | Ephemeral | Raw `messages[]` from the current agent's LLM conversation |

### Graph State (explicit memory)

The shared `memory` object on `WorkflowState`. This is the **only** way agents communicate. It's persisted after every node execution, enabling time-travel debugging and crash recovery.

### Thread Context (implicit memory)

The raw LLM conversation history within a single agent execution. Each agent has its own thread — agents don't see each other's raw messages, only the shared state.

**Why ephemeral?** Keeping 50 agents' full chat histories would cause token overflow. The agents extract what matters via `save_to_memory` and the thread is discarded.

## State slicing

Nodes never receive the full `WorkflowState`. The orchestrator creates a filtered view based on each node's `read_keys`:

```typescript
// Node config
{ read_keys: ['goal', 'notes'], write_keys: ['draft'] }

// Agent sees only:
{ goal: "Write a blog post", notes: "..." }

// Agent cannot access: review_score, topic, or any other keys
```

This is the **Zero Trust** model — no node sees more than it needs to.

## Subgraph isolation

When a subgraph executes:

1. **Input mapping**: Parent state → Child state (explicit key mapping)
2. **Execution**: Child operates with its own isolated memory
3. **Output mapping**: Child result → Parent state (explicit key mapping)
4. **Cleanup**: Internal loop counters and temporary values are discarded

## Tainted data

Any data entering the system from external tools (web search, file reads) is flagged as **tainted**. Taint propagates — if a node reads tainted data and writes to state, the output key inherits the taint flag. This enables downstream nodes to make trust decisions about their inputs.

## Next steps

- [Agents](/concepts/agents/) — how agents read and write state
- [Reducers](/concepts/reducers/) — how state mutations are applied
- [Security](/security/) — Zero Trust model and taint tracking
