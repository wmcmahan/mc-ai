---
title: Reducers
description: How state changes work in MC-AI — pure functions that merge actions into state.
---

Agents never mutate state directly. Instead, they emit **actions**, and pure **reducer functions** merge those actions into the existing state.

## The pattern

```
(CurrentState, Action) → NewState
```

This is the same pattern used by Redux, Elm, and event sourcing systems. Every state change is explicit, traceable, and reproducible.

## Why reducers?

- **No race conditions** — parallel nodes can't corrupt shared state because they don't touch it directly
- **Full auditability** — every state change is tied to an action with a source node
- **Crash recovery** — state is a deterministic function of all actions applied so far
- **Permission enforcement** — the reducer validates that the agent only wrote to its allowed `write_keys`

## How it works

1. An agent calls `save_to_memory({ key: "notes", value: "..." })`
2. The executor packages this into an `Action`:
   ```typescript
   {
     type: 'SAVE_MEMORY',
     node_id: 'researcher',
     key: 'notes',
     value: '...',
   }
   ```
3. The reducer validates `write_keys` and merges:
   ```typescript
   function reducer(state: WorkflowState, action: Action): WorkflowState {
     // Validate: is 'notes' in the agent's write_keys?
     // Merge: state.memory.notes = action.value
     return { ...state, memory: { ...state.memory, [action.key]: action.value } };
   }
   ```
4. The new state is persisted and execution continues

## Taint propagation

If an agent reads any tainted keys (data from external tools), the reducer automatically marks its output keys as tainted too. This propagation ensures downstream nodes can make trust decisions about their inputs.

## Best practices

**Agents are data, not classes:**
```typescript
// ❌ Bad: class-based agent
class ResearcherAgent extends BaseAgent { ... }

// ✅ Good: config-driven agent
const ResearcherConfig = {
  id: "researcher",
  model: "claude-sonnet-4-20250514",
  system_prompt: "You are a...",
  tools: [{ type: "mcp", server_id: "web-search" }],
};
```

**Schema-first validation:**
Every input and output should have a Zod schema:
```typescript
// Tool inputs
parameters: z.object({ query: z.string() })

// Agent configs
AgentConfigSchema.parse(config)
```

## Next steps

- [Agents](/concepts/agents/) — how agents produce actions
- [Workflow State](/concepts/workflow-state/) — the shared state that reducers update
- [Security](/security/) — how write_keys and taint tracking enforce Zero Trust
