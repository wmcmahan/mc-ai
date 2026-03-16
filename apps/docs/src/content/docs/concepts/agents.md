---
title: Agents
description: How agents are defined, configured, and executed in MC-AI.
---

## Agents

MC-AI treats agents as **configuration, not code**. There are no base classes to extend, no framework to inherit from. An agent is a JSON object that the engine feeds into the runtime.

### Agent configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` (UUID) | auto-generated | Unique identifier, returned by `registry.register()`. |
| `name` | `string` | *required* | Human-readable name used in UI and traces. |
| `description` | `string` | — | Used by supervisor nodes to route work to this agent. |
| `model` | `string` | *required* | Model ID (e.g. `'claude-3-5-sonnet-latest'`, `'gpt-4o'`). |
| `provider` | `string` | *required* | Provider mapped in `ProviderRegistry` (e.g. `'anthropic'`). |
| `system_prompt` | `string` | *required* | The persona, instructions, and rules for the LLM. |
| `temperature` | `number` | `0.7` | Value between 0.0 (deterministic) and 1.0 (creative). |
| `max_steps` | `number` | `10` | Safety limit for multi-step tool execution loops. |
| `tools` | `ToolSource[]` | `[]` | MCP tools this agent can access (e.g. `[{ type: "mcp", name: "github" }]`). |
| `permissions` | `object` | *required* | Zero-trust state permissions (`read_keys`, `write_keys`). |

## Agent registry

The `AgentRegistry` is a lookup interface to load these configurations into the runtime. You can implement your own (e.g. reading from a database), but the framework provides `InMemoryAgentRegistry` and `PostgresAgentRegistry`.

```typescript
import { InMemoryAgentRegistry } from '@mcai/orchestrator';

const registry = new InMemoryAgentRegistry();

registry.register({
  id: 'researcher-001',
  name: 'Researcher',
  model: 'claude-3-5-sonnet-latest',
  provider: 'anthropic',
  system_prompt: 'You are a research specialist...',
  temperature: 0.5,
  max_steps: 5,
  tools: [{ type: 'mcp', name: 'web_search' }],
  permissions: { 
    read_keys: ['topic'], 
    write_keys: ['notes'] 
  },
});
```

## Runtime execution

When an agent node runs, the **agent executor**:

1. Loads the config from the `AgentRegistry` via the node's `agent_id`
2. Creates a **state view** — a precise slice of `WorkflowState.memory` based on `read_keys`
3. Injects the goal, constraints, and state view into the prompt
4. Streams the LLM execution via `ai` with the configured tools
5. Captures all `save_to_memory` outputs across all steps
6. Validates write permissions (rejecting writes to restricted keys)
7. Packages the result into an action payload

All external tool inputs are automatically flagged as **tainted**. The executor propagates this taint to any memory keys written by the agent, ensuring downstream nodes can track the origin of the data.

## Next steps

- [Custom LLM Providers](/guides/custom-providers/) — use Groq, Ollama, or any provider
- [Your First Workflow](/guides/first-workflow/) — build an end-to-end workflow
