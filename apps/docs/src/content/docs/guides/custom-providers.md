---
title: Custom LLM Providers
description: Register Groq, Ollama, or any Vercel AI SDK-compatible provider.
---

By default, OpenAI and Anthropic are pre-registered. The `ProviderRegistry` lets you add any Vercel AI SDK-compatible provider at runtime — no engine code changes required.

## Registering a custom provider

```typescript
import { createOpenAI } from '@ai-sdk/openai';
import {
  ProviderRegistry,
  registerBuiltInProviders,
  configureProviderRegistry,
} from '@mcai/orchestrator';

// Start with built-in OpenAI + Anthropic
const providers = new ProviderRegistry();
registerBuiltInProviders(providers);

// Add Groq (OpenAI-compatible API)
const groq = createOpenAI({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY!,
});
providers.register('groq', {
  createLanguageModel: (modelId) => groq(modelId),
  modelPrefixes: ['llama-', 'mixtral-', 'gemma-'],
});

// Add Ollama (local inference, no API key required)
const ollama = createOpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',  // required by SDK but unused
});
providers.register('ollama', {
  createLanguageModel: (modelId) => ollama(modelId),
});

// Wire into the engine
configureProviderRegistry(providers);
```

## Using custom providers in agent configs

Once registered, agents can reference the provider by name:

```json
{
  "id": "fast-researcher",
  "model": "llama-3.3-70b-versatile",
  "provider": "groq",
  "system_prompt": "You are a research specialist...",
  "tools": ["web_search"]
}
```

## Model prefix auto-inference

Each provider can declare `modelPrefixes` during registration. When an agent config omits the `provider` field, the engine infers it from the model name:

| Model Name | Matched Prefix | Inferred Provider |
|------------|---------------|-------------------|
| `gpt-4-turbo` | `gpt-` | `openai` |
| `claude-sonnet-4-20250514` | `claude-` | `anthropic` |
| `llama-3.3-70b` | `llama-` | `groq` |
| `mixtral-8x7b` | `mixtral-` | `groq` |

If no prefix matches, the default provider (`anthropic`) is used.

## API reference

| Export | Description |
|--------|-------------|
| `ProviderRegistry` | Class — register, unregister, list, and create models |
| `ProviderRegistration` | Type — `{ createLanguageModel, modelPrefixes? }` |
| `registerBuiltInProviders(registry)` | Registers OpenAI + Anthropic with lazy API key resolution |
| `createDefaultProviderRegistry()` | Returns a registry with built-ins pre-registered |
| `configureProviderRegistry(registry)` | Wires a registry into the global agent factory |

## Next steps

- [Agents](/concepts/agents/) — how agents use providers
- [Adding MCP Tools](/guides/adding-tools/) — give agents external capabilities
