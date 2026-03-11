---
title: Custom LLM Providers
description: Register Groq, Ollama, or any Vercel AI SDK-compatible provider.
---

By default, OpenAI and Anthropic are pre-registered. The `ProviderRegistry` lets you add any Vercel AI SDK-compatible provider at runtime — no engine code changes required.

## Registering a provider

```typescript
import { createGroq } from '@ai-sdk/groq';
import { createProviderRegistry, configureProviderRegistry } from '@mcai/orchestrator';

// Start with built-in OpenAI + Anthropic
const providers = createProviderRegistry();

// Wire into the engine
configureProviderRegistry(providers);
```

## Using providers in agent configs

Once registered, agents can reference the provider by name:

```json
{
  "id": "fast-researcher",
  "model": "llama-3.3-70b-versatile",
  "provider": "groq",
  "system_prompt": "You are a research specialist...",
  "tools": [{ "type": "mcp", "server_id": "web-search" }]
}
```

## Using provider options in agent configs

Once registered, agents can reference the provider by name:

```json
{
  "id": "fast-researcher",
  "model": "claude-opus-4-20250514",
  "provider": "anthropic",
  "provider_options": {
    "effort": "max",
    "thinking": {
      "type": "enabled",
      "budgetTokens": 12000
    }
  },
  "system_prompt": "You are a research specialist...",
  "tools": [{ "type": "mcp", "server_id": "web-search" }]
}
```

## Model inference and validation

Each provider declares a list of known `models` during registration. When an agent config omits the `provider` field, the engine infers it by exact match against these lists:

| Model Name | Inferred Provider |
|------------|-------------------|
| `gpt-4-turbo` | `openai` |
| `claude-sonnet-4-20250514` | `anthropic` |
| `llama-3.3-70b-versatile` | `groq` |

If no match is found, the default provider (`anthropic`) is used.

:::note
The model list is **advisory, not a strict allowlist**. When `resolveModel()` is called with an unrecognised model ID, the engine logs a warning but still forwards the request to the provider. This allows using newly released models before the known list is updated.
:::

Use `addModel()` to register new model names at runtime without re-registering the entire provider:

```typescript
providers.addModel('openai', 'gpt-5');
```

Use `supportsModel()` to check if a model is in the known list:

```typescript
providers.supportsModel('openai', 'gpt-4o'); // true
```

## API reference

| Export | Description |
|--------|-------------|
| `ProviderRegistry` | Class — register, unregister, list, resolve models, validate |
| `LanguageModelFactory` | Type — `(modelId: string) => LanguageModel` |
| `ProviderOptions` | Type — `{ models: string[] }` |
| `createProviderRegistry()` | Returns a registry with built-ins pre-registered |
| `configureProviderRegistry(registry)` | Wires a registry into the global agent factory |

## Next steps

- [Agents](/concepts/agents/) — how agents use providers
- [Adding MCP Tools](/guides/adding-tools/) — give agents external capabilities

