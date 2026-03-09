# Examples

Runnable examples for `@mcai/orchestrator`.

## Prerequisites

- Node.js 22+
- `ANTHROPIC_API_KEY` environment variable (get one at [console.anthropic.com](https://console.anthropic.com))

> To use OpenAI instead, change `provider` to `'openai'`, update the `model` field (e.g. `'gpt-4o'`), and set `OPENAI_API_KEY`. Both providers are built-in. For other providers (Groq, Ollama, Mistral, etc.), register them via `ProviderRegistry` — see the [Custom LLM Providers](../README.md#custom-llm-providers) section.

## Available Examples

| Example | Pattern | Description |
|---------|---------|-------------|
| [research-and-write](./research-and-write/) | Linear | 2-node pipeline: Researcher gathers notes, Writer produces a polished summary |
| [supervisor-routing](./supervisor-routing/) | Supervisor | 4-node cyclic hub-and-spoke: Supervisor dynamically routes between Research, Write, and Edit specialists |
| [human-in-the-loop](./human-in-the-loop/) | Approval Gate | 3-node pipeline with approval gate: Writer drafts, human reviews, Publisher finalizes |
| [map-reduce](./map-reduce/) | Map-Reduce | 4-node fan-out: Splitter decomposes a topic, Map fans out to parallel Researchers, Synthesizer merges results |
| [eval-loop](./eval-loop/) | Conditional Cycle | 3-node cyclic graph: Writer drafts, Evaluator scores, loops back until quality gate (score >= 0.8) passes |
| [streaming](./streaming/) | Streaming | Real-time event streaming with token-by-token output via `stream()` async generator |
| [evals](./evals/) | Eval Framework | Example eval suites showing how to write assertions against workflow outputs |

## Quick Start

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/supervisor-routing/supervisor-routing.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/human-in-the-loop/human-in-the-loop.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/map-reduce/map-reduce.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/eval-loop/eval-loop.ts
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/streaming/streaming.ts
```

## Next Steps

- [README.md](../README.md) — Package overview, API reference, and custom provider setup
