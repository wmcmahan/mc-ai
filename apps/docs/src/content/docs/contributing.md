---
title: Contributing
description: Development setup, coding standards, and contribution guidelines.
---

## Getting started

```bash
git clone https://github.com/wmcmahan/mc-ai.git
cd mc-ai
npm install
```

## Running tests

```bash
npm test
```

## Coding standards

### Architecture

The system is an **Async Cyclic State Graph**:
- **Orchestrator**: Stateless. Manages graph traversal.
- **State**: The `WorkflowState` is specific to each graph but follows a shared shape.
- **Communication**: Use **MCP** for external tools.

### Technology stack

- **Runtime**: Node.js v22+ (ES Modules)
- **Language**: TypeScript v5+ (Strict Mode)
- **Agents**: Vercel AI SDK v6 (`streamText` for agents, `generateText` for supervisors)
- **Testing**: Vitest (Unit) + Custom Eval Runner
- **Validation**: Zod schemas for all inputs/outputs

### Agents are data, not classes

```typescript
// ❌ Bad
class ResearcherAgent extends BaseAgent { ... }

// ✅ Good
const ResearcherConfig: AgentRegistryEntry = {
  id: "researcher",
  model: "claude-sonnet-4-20250514",
  system_prompt: "You are a...",
  tools: [{ type: "mcp", server_id: "web-search" }],
};
```

### State mutation via reducers

Agents never mutate state directly:

```typescript
// ❌ Bad
state.results.push(data);

// ✅ Good: agents emit actions, reducers apply them
function reducer(state, action) {
  if (action.type === 'SAVE_MEMORY') {
    return { ...state, memory: { ...state.memory, [action.key]: action.value } };
  }
  return state;
}
```

### Schema-first (Zod)

Every input/output must have a Zod schema:
- Tool inputs: `parameters: z.object(...)`
- Agent configs: `AgentConfigSchema.parse(config)`

### Error handling

Use typed error classes for structured errors. If a graph node fails, catch the error, mark the state as `failed`, and emit a `workflow:failed` event.

## Full guidelines

See [CONTRIBUTING.md](https://github.com/wmcmahan/mc-ai/blob/main/CONTRIBUTING.md) for the complete contribution guide including PR process, branch naming, and commit conventions.
