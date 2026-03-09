---
title: Tracing
description: Opt-in OpenTelemetry distributed tracing for workflow execution.
---

MC-AI supports **opt-in OpenTelemetry tracing** for full visibility into workflow execution, node timings, LLM calls, and tool invocations.

## Setup

Tracing is enabled via the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable. When unset, all tracing is a no-op with zero overhead (dynamic imports ensure OTel machinery is never loaded).

### Initialize at startup

```typescript
import { initTracing } from '@mcai/orchestrator';

// Call once at app startup (before any traced code)
await initTracing('orchestrator');
```

### Run with tracing

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node app.js
```

## Span hierarchy

```
workflow.run (graph-runner.ts)
├── node.execute.supervisor (graph-runner.ts)
│   └── supervisor.route (supervisor-executor.ts)
├── node.execute.agent (graph-runner.ts)
│   └── agent.execute (agent-executor.ts)
└── node.execute.tool (graph-runner.ts)
```

## Span attributes

| Span | Attributes |
|------|-----------| 
| `workflow.run` | `workflow.id`, `graph.id`, `graph.name`, `run.id`, `workflow.duration_ms`, `workflow.status`, `workflow.iterations` |
| `agent.execute` | `agent.id`, `agent.model`, `agent.provider`, `agent.tokens.input`, `agent.tokens.output`, `agent.tools_called` |
| `supervisor.route` | `supervisor.id`, `supervisor.decision`, `supervisor.reasoning`, `supervisor.iteration`, `supervisor.input_tokens`, `supervisor.output_tokens` |

## What you'll see

- **Workflow Run**: Total duration and status
- **Supervisor Decisions**: Why it chose a particular node (reasoning captured in span)
- **Agent Execution**: Model used, token usage (input/output), tools called
- **Tool Calls**: Inputs and outputs of every MCP call

## Viewing traces

With Jaeger (or any OTLP-compatible collector):

```bash
# If using Docker Compose, Jaeger is included
docker compose up jaeger

# View traces
open http://localhost:16686
```

Other compatible collectors: Axiom, LangFuse, Honeycomb, Grafana Tempo.

## Next steps

- [Evaluations](/observability/evals/) — verify agent behavior with automated evals
