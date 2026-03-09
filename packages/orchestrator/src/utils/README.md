# Utils — Technical Reference

> **Scope**: This document covers the utility modules in `@mcai/orchestrator`: structured logging, distributed tracing, and taint tracking.

---

## Overview

| File | Purpose |
|------|---------|
| `logger.ts` | Structured JSON logging with levels, context, and namespacing |
| `tracing.ts` | OpenTelemetry distributed tracing (opt-in via environment variable) |
| `taint.ts` | Data provenance tracking for external tool results |

---

## Logger (`logger.ts`)

Production-grade structured logging. All output is JSON, written to `stdout` (info/debug) or `stderr` (warn/error).

### `createLogger(component, context?): Logger`

Factory function that creates a namespaced logger instance.

```typescript
import { createLogger } from '@mcai/orchestrator';

const log = createLogger('runner.graph');
log.info('workflow_started', { workflow_id: 'abc', run_id: '123' });
// → {"timestamp":"...","level":"info","event":"runner.graph.workflow_started","context":{"workflow_id":"abc","run_id":"123"}}
```

### Logger Class

| Method | Signature | Output |
|--------|-----------|--------|
| `debug(event, context?)` | `(string, Record?) → void` | Lowest priority, filtered by default |
| `info(event, context?)` | `(string, Record?) → void` | Standard operational events |
| `warn(event, context?)` | `(string, Record?) → void` | Suspicious but non-fatal conditions |
| `error(event, error?, context?)` | `(string, Error?, Record?) → void` | Errors with optional stack trace |
| `child(context)` | `(Record) → Logger` | Creates a child logger with merged default context |

### Log Level Filtering

Controlled by `LOG_LEVEL` environment variable. Priority order: `debug < info < warn < error`. Default: `info`.

### Log Entry Format

```typescript
{
  timestamp: string;  // ISO 8601
  level: LogLevel;    // 'debug' | 'info' | 'warn' | 'error'
  event: string;      // "{component}.{event}" namespaced
  context?: Record;   // Structured metadata
}
```

### Namespaces Used in the Codebase

| Namespace | Component |
|-----------|-----------|
| `runner.graph` | GraphRunner core |
| `runner.conditions` | Edge condition evaluation |
| `runner.parallel` | Parallel executor |
| `runner.node.*` | Node executors (agent, tool, supervisor, etc.) |
| `agent.executor` | Agent executor |
| `agent.factory` | Agent factory |
| `agent.evaluator` | Evaluator executor |
| `agent.supervisor` | Supervisor executor |
| `architect` | Workflow architect |
| `architect.tools` | Architect tool handlers |
| `db.persistence` | State persistence |
| `mcp.gateway` | MCP gateway client |
| `mcp.tools` | Tool adapter |
| `mcp.schema` | JSON schema converter |

---

## Tracing (`tracing.ts`)

OpenTelemetry distributed tracing with OTLP HTTP export. **Opt-in** — when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set, all tracing is a no-op with zero overhead.

### `initTracing(serviceName): Promise<void>`

Must be called once at application startup, before any traced code runs. Dynamically imports OTel packages only when tracing is enabled.

```typescript
import { initTracing } from '@mcai/orchestrator';

await initTracing('orchestrator');
// Traces sent to: ${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces
```

Registers SIGTERM/SIGINT handlers for graceful shutdown of the trace exporter.

### `getTracer(name): Tracer`

Returns a named tracer instance. Returns a no-op tracer if OTel is not initialized, so callers never need to check if tracing is enabled.

```typescript
const tracer = getTracer('runner.graph');
```

### `withSpan(tracer, name, fn, attributes?): Promise<T>`

Executes an async function within a new span. Automatically:
- Creates a child span under the current context
- Sets span status to `OK` on success, `ERROR` on exception
- Records exceptions on the span
- Ends the span when the function completes

```typescript
const result = await withSpan(tracer, 'workflow.run', async (span) => {
  span.setAttribute('workflow.id', workflowId);
  // ... do work ...
  return finalState;
});
```

### Span Hierarchy

```
workflow.run (3.2s) — workflow_id, graph_name, status
├── node.execute.supervisor (120ms) — decision: research, reasoning: "..."
├── node.execute.agent (1.8s)
│   └── agent.execute — model: claude-sonnet-4, tokens: 1200/450
├── node.execute.supervisor (95ms) — decision: writer
└── node.execute.supervisor (80ms) — decision: __done__
```

### Re-exports

`SpanStatusCode`, `context`, `Span` from `@opentelemetry/api` for convenience.

---

## Taint Tracking (`taint.ts`)

Data provenance system that tracks which memory keys contain external (untrusted) data. The taint registry is stored at `memory._taint_registry`.

### Functions

#### `markTainted(memory, key, meta): void`

Marks a memory key as tainted with source metadata. Mutates the memory object's `_taint_registry`.

```typescript
markTainted(state.memory, 'search_results', {
  source: 'mcp_tool',
  tool_name: 'web_search',
  created_at: new Date().toISOString(),
});
```

#### `isTainted(memory, key): boolean`

Checks if a memory key is tainted.

#### `getTaintRegistry(memory): TaintRegistry`

Returns the full taint registry. Returns empty object `{}` if no registry exists.

#### `getTaintInfo(memory, key): TaintMetadata | undefined`

Gets taint metadata for a specific key.

#### `propagateDerivedTaint(memory, outputKeys, agentId): TaintRegistry`

Propagates taint from input memory to output keys. If any of the agent's readable memory keys are tainted, all output keys are marked as `derived` tainted.

Returns only the new entries (not the full registry). The caller merges these into the existing registry.

### Taint Sources

| Source | When Applied |
|--------|-------------|
| `mcp_tool` | MCP tool adapter wraps all external tool results |
| `tool_node` | Tool node executor propagates from tool results |
| `agent_response` | Agent output from external-data-influenced execution |
| `derived` | Any output produced from tainted inputs |

### Protection

The `_taint_registry` key is protected by the agent executor's rule that blocks writes to keys starting with `_`. Agents cannot tamper with their own taint status.
