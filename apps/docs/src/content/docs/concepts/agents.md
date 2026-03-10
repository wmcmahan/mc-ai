---
title: Agents
description: How agents are defined, configured, and executed in MC-AI.
---

## Philosophy: thin wrapper, maximum capability

MC-AI treats agents as **configuration, not code**. There are no base classes to extend, no framework to inherit from. An agent is a JSON object that the engine feeds into the Vercel AI SDK runtime.

:::note
MC-AI is built on **[Vercel AI SDK v6](https://sdk.vercel.ai/docs)**. Agent nodes use `streamText` with `stopWhen: stepCountIs(maxSteps)` for multi-step tool use. Supervisor and evaluator nodes use `generateText` with `Output.object()` for structured routing decisions.
:::

## Agent config

```typescript
interface AgentRegistryEntry {
  id: string;              // Unique identifier (UUID)
  name: string;            // Human-readable name
  description?: string;    // Used by supervisors to understand this agent's purpose

  // LLM configuration
  model: string;           // Model ID (e.g., "claude-sonnet-4-20250514", "gpt-4o")
  provider: string;        // Provider name (e.g., "anthropic", "openai", "groq")
  system_prompt: string;   // The "soul" of the agent — persona, constraints, style
  temperature: number;     // Creativity (0.0 = deterministic, 1.0 = creative)
  max_steps: number;       // Safety limit for tool-use loops (default: 10)

  // Capabilities — structured tool sources
  tools: ToolSource[];     // Built-in tools and MCP server references

  // Security (Zero Trust)
  permissions: {
    read_keys: string[];   // State keys this agent can read
    write_keys: string[];  // State keys this agent can write
    budget_usd?: number;   // Max cost per run
  };
}

// Tool source types
type ToolSource =
  | { type: 'builtin'; name: 'save_to_memory' | 'architect_*' }
  | { type: 'mcp'; server_id: string; tool_names?: string[] };
```

The `provider` field accepts any string — not just `'openai'` or `'anthropic'`. Any Vercel AI SDK-compatible provider can be registered at runtime via the `ProviderRegistry`. See [Custom LLM Providers](/guides/custom-providers/) for details.

## Agent registry

Agents are registered in an `AgentRegistry` before the graph runs:

```typescript
import { InMemoryAgentRegistry, configureAgentFactory } from '@mcai/orchestrator';

const registry = new InMemoryAgentRegistry();
registry.register({
  id: 'researcher-001',
  name: 'Researcher',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'You are a research specialist...',
  temperature: 0.5,
  max_steps: 5,
  tools: [
    { type: 'builtin', name: 'save_to_memory' },
    { type: 'mcp', server_id: 'web-search' },
  ],
  permissions: { read_keys: ['topic'], write_keys: ['notes'] },
});

configureAgentFactory(registry);
```

For production, use `@mcai/orchestrator-postgres` to load agent configs from a database.

## Runtime execution

The agent executor:

1. Loads the agent config from the registry
2. Creates a **state view** — a filtered slice of `WorkflowState.memory` based on `read_keys`
3. Builds the prompt with the goal, state view, and iteration context
4. Calls `streamText` with the configured model, system prompt, and tools
5. Extracts `save_to_memory` tool calls from all steps
6. Validates write permissions (Zero Trust)
7. Propagates taint from any tainted input keys
8. Packages everything into an `Action` for the reducer

```typescript
import { streamText, stepCountIs } from 'ai';

const result = await streamText({
  model,                            // Resolved from config via ProviderRegistry
  system: systemPrompt,             // Built from config + injected state view
  prompt: taskPrompt,               // Goal + iteration context
  tools,                            // Resolved from ToolSource[] via MCPConnectionManager
  stopWhen: stepCountIs(maxSteps),
  abortSignal: combinedSignal,      // Workflow cancellation + timeout
});
```

## save_to_memory

The primary way agents write to state is via the built-in `save_to_memory` tool. This tool is automatically available to every agent:

```
Agent: "I'll save my research notes."
→ save_to_memory({ key: "notes", value: "..." })
```

The key must match one of the agent's `write_keys`. If it doesn't, the write is rejected.

## Creating a new agent

Add a JSON config to the registry. No classes needed:

```json
{
  "id": "coding-assistant",
  "name": "Coding Assistant",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "system_prompt": "You are an expert TypeScript engineer...",
  "temperature": 0.3,
  "max_steps": 10,
  "tools": [
    { "type": "builtin", "name": "save_to_memory" },
    { "type": "mcp", "server_id": "code-sandbox", "tool_names": ["fs_read", "fs_write"] }
  ],
  "permissions": {
    "read_keys": ["goal", "requirements"],
    "write_keys": ["code_output"]
  }
}
```

## Next steps

- [Reducers](/concepts/reducers/) — how agent outputs become state changes
- [Custom LLM Providers](/guides/custom-providers/) — use Groq, Ollama, or any provider
- [Your First Workflow](/guides/first-workflow/) — build an end-to-end workflow
