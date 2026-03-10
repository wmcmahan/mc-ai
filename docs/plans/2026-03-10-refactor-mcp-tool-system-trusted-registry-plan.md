---
title: "Refactor MCP Tool System with Trusted Server Registry"
type: refactor
status: active
date: 2026-03-10
deepened: 2026-03-10
---

# Refactor MCP Tool System with Trusted Server Registry

## Enhancement Summary

**Deepened on:** 2026-03-10
**Review agents used:** Simplicity Reviewer, TypeScript Reviewer, Data Migration Expert, Pattern Recognition Specialist, Architecture Strategist, Performance Oracle, Agent-Native Reviewer

### Key Improvements

1. **Simplification opportunities identified**: Replace `MCPServerRegistry` async interface with `ReadonlyMap<string, MCPServerEntry>` for in-memory use. Consider removing `allowed_agents` (handle at registry level) and `required` field (default to fail-fast). Collision-only namespacing instead of always-namespace.
2. **Connection stampede prevention**: Use pending-promise dedup pattern in `MCPConnectionManager.getClient()` to prevent multiple concurrent `createMCPClient()` calls for the same server.
3. **Missing type updates identified**: `AgentRegistryEntry.tools` in `persistence/interfaces.ts`, `AgentConfigShape` in `node-executors/context.ts`, and `GraphRunnerOptions` all need updating alongside `AgentConfig`.
4. **Data migration safety**: Phantom `'default'` server_id in migration SQL requires a corresponding registry entry to be seeded. DOWN migration and verification SQL needed.
5. **Tool node type impact**: Removing `executeToolCall` breaks the `tool` node type executor — needs a replacement strategy.
6. **Agent-native tool discovery**: `architect_list_mcp_servers` should be generalized so any agent (not just Architect) can discover available tools at runtime.

### New Considerations Discovered

- `@ai-sdk/mcp` concurrency safety needs verification — does `client.tools()` return the same reference or new objects each call?
- Taint wrapping should be immutable (spread + override, not mutation) to avoid side effects on shared tool objects
- Use `__` separator instead of `/` for namespaced tool names to avoid path-parsing confusion in LLMs
- Consider caching resolved tool sets per `(agentId, toolSources hash)` to avoid redundant resolution for multi-step agents
- Parallelize multi-server `createMCPClient()` connections with `Promise.allSettled()` for faster startup

---

## Overview

Replace the custom `MCPGatewayClient` HTTP proxy with Vercel AI SDK's native `@ai-sdk/mcp` package, introduce a trusted MCP Server Registry as a security boundary, and change `AgentConfig.tools` from `string[]` to structured `ToolSource[]`. This unifies three competing tool patterns (built-in, architect, MCP gateway) into one: tools are AI SDK tool objects resolved from declared sources.

## Problem Statement

The current MCP and tool system has three structural problems:

1. **Unvalidated tool references**: Agent configs declare `tools: string[]` — bare strings with no compile-time or registration-time validation. A typo like `"web_serach"` fails silently at runtime (`tool-adapter.ts:108`).

2. **Redundant custom gateway**: `MCPGatewayClient` (`gateway-client.ts`) is a bespoke HTTP proxy that duplicates what `@ai-sdk/mcp` provides natively — transport management, JSON Schema conversion, tool execution lifecycle. It requires a separate running gateway service and creates a single point of failure.

3. **Static, single-source tool resolution**: Tools come from exactly one MCP gateway URL (`MCP_GATEWAY_URL` env var). There is no way to register multiple MCP servers, connect to them at runtime, or declare MCP requirements per-agent or per-workflow.

## Proposed Solution

Two-layer architecture separating trust boundaries:

```
┌─────────────────────────────┐     ┌──────────────────────────────────┐
│  Agent Config (untrusted)   │     │  MCP Server Registry (trusted)   │
│                             │     │                                  │
│  tools:                     │     │  "search" → { http, url, auth }  │
│    - builtin: save_to_memory│     │  "fs"     → { stdio, cmd, args } │
│    - mcp:                   │──┐  │  "api"    → { sse, url }         │
│        server_id: "search"  │  │  └──────────────────────────────────┘
│        tools: ["web_search"]│  │                  │
│    - mcp:                   │  └──── lookup ──────┘
│        server_id: "fs"      │                     │
└─────────────────────────────┘                     ▼
                                         @ai-sdk/mcp createMCPClient()
                                                    │
                                                    ▼
                                          client.tools() → ToolSet
                                                    │
                                          merge with built-ins
                                                    │
                                          taint-wrap execute callbacks
                                                    │
                                                    ▼
                                          streamText({ tools })
```

**Agent configs** declare what tools they need via `tools: ToolSource[]` — serializable JSON referencing server IDs, never transport configs. **The registry** holds the trusted transport configurations, authentication, and access control. **Resolution** happens at execution time via `@ai-sdk/mcp`, which handles JSON Schema conversion, transport management, and tool execution natively.

## Technical Approach

### Architecture

#### New Type: `ToolSource` (Zod schema)

```typescript
// packages/orchestrator/src/types/tools.ts (NEW FILE)

const BuiltinToolSourceSchema = z.object({
  type: z.literal('builtin'),
  name: z.string(), // 'save_to_memory' | 'architect_*'
});

const MCPToolSourceSchema = z.object({
  type: z.literal('mcp'),
  server_id: z.string(),
  tools: z.array(z.string()).optional(), // filter; omit = all tools from server
  required: z.boolean().default(true),   // fail workflow if server unavailable?
});

const ToolSourceSchema = z.discriminatedUnion('type', [
  BuiltinToolSourceSchema,
  MCPToolSourceSchema,
]);

type ToolSource = z.infer<typeof ToolSourceSchema>;
```

> **Research Insights — ToolSource Schema**
>
> - **Tighten `BuiltinToolSourceSchema.name`** (TypeScript Reviewer): Use `z.enum(['save_to_memory', 'architect_draft_workflow', 'architect_publish_workflow', 'architect_get_workflow'])` instead of `z.string()` to catch typos at parse time.
> - **Consider removing `required` field** (Simplicity Reviewer): Default to fail-fast (required). Optional tools add complexity for a rare use case — defer until needed. If kept, consider `optional: true` (inverted default) for clearer semantics.
> - **Evaluate simplifying MCPToolSource** (Simplicity Reviewer): If `tools` filter is rarely used, consider deferring it. Start with server-level granularity, add tool-level filtering in a follow-up.

#### New Type: `MCPServerEntry` (Registry data)

```typescript
// packages/orchestrator/src/types/tools.ts

// Security: command allowlist prevents arbitrary host execution (CLAUDE.md mandate)
const ALLOWED_STDIO_COMMANDS = ['npx', 'node', 'python3', 'python', 'uvx'] as const;

const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.enum(ALLOWED_STDIO_COMMANDS),
  args: z.array(z.string().regex(/^[^;|&`$]+$/)).default([]),  // reject shell metacharacters
  env: z.record(z.string()).optional(),
  // Note: env keys like LD_PRELOAD, NODE_OPTIONS must be blocked at runtime
});

const HTTPTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const SSETransportSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const MCPTransportConfigSchema = z.discriminatedUnion('type', [
  StdioTransportSchema,
  HTTPTransportSchema,
  SSETransportSchema,
]);

const MCPServerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  transport: MCPTransportConfigSchema,
  allowed_agents: z.array(z.string()).optional(), // agent IDs permitted to use this server; omit = all
  timeout_ms: z.number().default(30_000),
});

type MCPServerEntry = z.infer<typeof MCPServerEntrySchema>;
```

#### New Interface: `MCPServerRegistry`

```typescript
// packages/orchestrator/src/persistence/interfaces.ts (ADD to existing)

export interface MCPServerRegistry {
  getServer(id: string): Promise<MCPServerEntry | null>;
  listServers(): Promise<MCPServerEntry[]>;
}
```

Read-only at the interface level. Write operations (registration) happen at the infrastructure layer — startup config, admin API, or Postgres seeding. Agents and the Architect cannot mutate it.

> **Research Insights — MCPServerRegistry**
>
> - **Consider `ReadonlyMap` instead of async interface** (Simplicity Reviewer): For in-memory use, `ReadonlyMap<string, MCPServerEntry>` is simpler than an async `getServer()/listServers()` interface. The async interface only matters for Postgres — inject it as a `Map` loaded at startup.
> - **Remove `allowed_agents` from the schema** (Simplicity Reviewer): Access control at the registry level is YAGNI until multi-tenant. If needed, enforce it at a higher level (e.g., middleware before `resolveTools`) rather than baking it into every `getClient()` call.
> - **Inject via interface, not concrete class** (Architecture Strategist): Define a `ToolResolver` interface (`resolveTools(sources, agentId) → ToolSet`) and have `MCPConnectionManager` implement it. This lets tests inject a stub without mocking the connection manager internals.

#### New Class: `MCPConnectionManager`

```typescript
// packages/orchestrator/src/mcp/connection-manager.ts (NEW FILE)

export class MCPConnectionManager {
  private clients: Map<string, MCPClient> = new Map();
  private registry: MCPServerRegistry;

  constructor(registry: MCPServerRegistry) { ... }

  /** Connect to a server by ID. Reuses existing connection. */
  async getClient(serverId: string): Promise<MCPClient> { ... }

  /** Resolve tools into a merged AI SDK ToolSet with taint wrapping. */
  async resolveTools(
    toolSources: ToolSource[],
    agentId: string,
  ): Promise<Record<string, Tool>> { ... }

  /** Close all connections. Call in finally block. */
  async closeAll(): Promise<void> { ... }
}
```

Key behaviors:
- Lazy connection: clients created on first `getClient()` call, cached for reuse within the workflow run.
- Access control: checks `MCPServerEntry.allowed_agents` against the requesting `agentId`.
- Taint wrapping: wraps every MCP tool's `execute` callback to produce `TaintedToolResult` with `server_id` provenance.
- Tool filtering: if a MCP tool source specifies a `tools` array, only those tools are included from that server.
- Graceful degradation: if a source has `required: false` and the server is unreachable, log a warning and continue. If `required: true`, throw.

> **Research Insights — MCPConnectionManager**
>
> - **Connection stampede prevention** (Performance Oracle): Use a pending-promise dedup pattern to prevent multiple concurrent `createMCPClient()` calls for the same server:
>   ```typescript
>   private pending: Map<string, Promise<MCPClient>> = new Map();
>   async getClient(serverId: string): Promise<MCPClient> {
>     if (this.clients.has(serverId)) return this.clients.get(serverId)!;
>     if (this.pending.has(serverId)) return this.pending.get(serverId)!;
>     const promise = this.connectToServer(serverId);
>     this.pending.set(serverId, promise);
>     try {
>       const client = await promise;
>       this.clients.set(serverId, client);
>       return client;
>     } finally {
>       this.pending.delete(serverId);
>     }
>   }
>   ```
> - **Parallelize multi-server connections** (Performance Oracle): In `resolveTools()`, group MCP sources by server and connect via `Promise.allSettled()` instead of sequential awaits.
> - **Immutable taint wrapping** (TypeScript Reviewer): Don't mutate the tool's `execute` property. Instead, create a new tool object with spread: `{ ...tool, execute: taintWrappedExecute }`. This avoids side effects if `@ai-sdk/mcp` returns shared tool references.
> - **Cache resolved tool sets** (Performance Oracle): For multi-step agents (e.g., supervisors that iterate), cache the resolved `ToolSet` keyed by `(agentId, hash(toolSources))` to avoid re-resolving on every iteration.
> - **Verify `@ai-sdk/mcp` concurrency safety** (Architecture Strategist): Test whether `client.tools()` is safe to call concurrently from multiple agents using the same server. If not, the connection-per-workflow-run model needs a mutex.

#### Updated `AgentConfig`

```typescript
// packages/orchestrator/src/agent/types.ts (MODIFY)

const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  model: z.string(),
  provider: z.string().optional(),
  system: z.string(),
  temperature: z.number().optional(),
  maxSteps: z.number().default(10),

  // CHANGED: from z.array(z.string()) to z.array(ToolSourceSchema)
  tools: z.array(ToolSourceSchema).default([]),

  read_keys: z.array(z.string()).default([]),
  write_keys: z.array(z.string()).default([]),
});
```

No backward compatibility — the `tools` field changes type directly. All existing agent configs (code, Postgres rows, examples) must be updated to use `ToolSource` objects.

> **Research Insights — AgentConfig Update**
>
> - **Update ALL type aliases** (Pattern Recognition): The `tools` type change must propagate to:
>   - `AgentRegistryEntry.tools` in `packages/orchestrator/src/persistence/interfaces.ts:196`
>   - `AgentConfigShape.tools` in `packages/orchestrator/src/runner/node-executors/context.ts:41-45`
>   - `GraphRunnerOptions` if it references agent tool types
>   - Any test fixtures or mocks that create `AgentConfig` objects
> - **Update supervisor executor** (Pattern Recognition): `supervisor-executor.ts` may reference `tools: string[]` in its managed agent handling — verify and update.

#### Updated `TaintMetadata`

```typescript
// packages/orchestrator/src/types/state.ts (MODIFY)

const TaintMetadataSchema = z.object({
  source: z.enum(['mcp_tool', 'tool_node', 'agent_response', 'derived']),
  tool_name: z.string().optional(),
  server_id: z.string().optional(),  // NEW — which MCP server provided this
  agent_id: z.string().optional(),
  created_at: z.string(),
});
```

#### Tool Name Collision Strategy

When two MCP servers expose tools with the same name, namespace them as `{server_id}/{tool_name}`:

```typescript
// In MCPConnectionManager.resolveTools():
const serverTools = await client.tools();
for (const [name, tool] of Object.entries(serverTools)) {
  const key = `${serverId}/${name}`;
  merged[key] = taintWrap(tool, serverId, agentId);
}
```

When an agent's `tools` specifies `tools: ["web_search"]` for `server_id: "search"`, the resolved tool name is `search/web_search`. The LLM sees namespaced tool names, eliminating ambiguity.

Built-in tools keep their unnamespaced names (`save_to_memory`, `architect_draft_workflow`).

> **Research Insights — Tool Name Collision Strategy**
>
> - **Collision-only namespacing** (Performance Oracle, Simplicity Reviewer): Always-namespace adds noise. LLMs work better with short, descriptive names. Only namespace when an actual collision is detected:
>   ```typescript
>   // Count tool name occurrences across all servers
>   const nameCounts = new Map<string, number>();
>   for (const [name] of allServerTools) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
>   // Only prefix when count > 1
>   const key = nameCounts.get(name)! > 1 ? `${serverId}__${name}` : name;
>   ```
> - **Use `__` separator, not `/`** (Architecture Strategist): `/` can confuse LLMs that interpret it as a path separator. `__` (double underscore) is unambiguous and commonly used for namespacing in tool systems.
> - **Log collisions** (Performance Oracle): When a collision is detected and namespacing is applied, emit a warning log so operators are aware.

### Implementation Phases

#### Phase 1: Foundation — Types, Registry, InMemory Implementation

**Goal**: Define all new types and interfaces. No behavioral changes yet.

**Files to create:**
- `packages/orchestrator/src/types/tools.ts` — `ToolSourceSchema`, `MCPServerEntrySchema`, `MCPTransportConfigSchema`
- `packages/orchestrator/src/persistence/in-memory.ts` — `InMemoryMCPServerRegistry` (add to existing file)

**Files to modify:**
- `packages/orchestrator/src/persistence/interfaces.ts` — add `MCPServerRegistry` interface, `MCPServerEntry` type
- `packages/orchestrator/src/types/state.ts` — add `server_id` to `TaintMetadata`
- `packages/orchestrator/src/index.ts` — export new types

**Tests:**
- Unit tests for Zod schemas (validate, reject invalid)
- Unit tests for `InMemoryMCPServerRegistry` CRUD

**Success criteria:**
- All new types compile and validate correctly
- Existing tests still pass (zero behavioral change)

---

#### Phase 2: MCPConnectionManager + `@ai-sdk/mcp` Integration

**Goal**: Build the connection manager that replaces `MCPGatewayClient`.

**Files to create:**
- `packages/orchestrator/src/mcp/connection-manager.ts` — `MCPConnectionManager` class

**Files to modify:**
- `packages/orchestrator/package.json` — add `@ai-sdk/mcp` as peer dependency

**Key implementation details:**
- `resolveTools()` iterates `tools`, calls `getClient()` per MCP source, merges results with built-ins
- Taint wrapping: create new tool object with wrapped `execute` callback (immutable — NEVER mutate the original):
  ```typescript
  // Immutable spread — do NOT mutate tool.execute in-place
  const wrappedTool = {
    ...tool,
    execute: async (args, options) => {
      const result = await tool.execute(args, options);
      return {
        result,
        taint: { source: 'mcp_tool', tool_name: name, server_id: serverId, agent_id: agentId, created_at: new Date().toISOString() },
      } satisfies TaintedToolResult;
    },
  };
  ```
- Access control enforcement in `getClient()`: check `entry.allowed_agents` against `agentId`
- Connection reuse: `Map<string, MCPClient>` keyed by server ID
- `closeAll()`: iterates all cached clients, calls `client.close()`, clears map

**Tests:**
- Unit tests with mocked `@ai-sdk/mcp` (mock `createMCPClient` to return fake tool sets)
- Test taint wrapping on tool results
- Test access control rejection
- Test connection reuse (same server ID returns same client)
- Test graceful degradation (`required: false` source with unreachable server)
- Test `closeAll()` cleanup

**Success criteria:**
- `MCPConnectionManager` resolves tool sources into a valid AI SDK ToolSet
- Taint metadata includes `server_id`
- Access control enforced
- Connections properly cleaned up

---

#### Phase 3: Wire into GraphRunner + Update Agent Executor

**Goal**: Replace the current tool resolution pipeline with the new system.

**Files to modify:**
- `packages/orchestrator/src/agent/types.ts` — change `tools` type from `string[]` to `ToolSource[]`
- `packages/orchestrator/src/runner/graph-runner.ts` — instantiate `MCPConnectionManager`, wire into deps, cleanup in `finally`
- `packages/orchestrator/src/runner/node-executors/context.ts` — update `ExecutorDependencies` interface
- `packages/orchestrator/src/runner/node-executors/agent.ts` — use `tools` for tool resolution
- `packages/orchestrator/src/runner/node-executors/tool.ts` — replace `executeToolCall` with `resolveAndExecuteTool`. The `tool` node type invokes a single named tool directly (no LLM). The node's `tool_id` (bare string) must be mapped to a `ToolSource` — either the `tool` GraphNode type gains a `tool_source: ToolSource` field, or the executor constructs a synthetic `ToolSource` from `tool_id` at runtime.
- `packages/orchestrator/src/runner/node-executors/map.ts` — same change for tool-type worker branch (line ~58)
- `packages/orchestrator/src/agent/agent-executor/executor.ts` — accept resolved ToolSet directly (no more `buildToolSet` wrapping for MCP tools since `@ai-sdk/mcp` provides AI SDK-native tools)

**GraphRunner changes:**
```typescript
// In GraphRunner.run() or constructor:
const connectionManager = new MCPConnectionManager(this.options.mcpServerRegistry);

try {
  // ... execution loop
} finally {
  await connectionManager.closeAll();
}
```

**Updated ExecutorDependencies:**
```typescript
interface ExecutorDependencies {
  // CHANGED: accepts ToolSource[] instead of string[]
  resolveTools: (toolSources: ToolSource[], agentId: string) => Promise<Record<string, Tool>>;

  // NEW: direct tool execution for `tool` node type (replaces executeToolCall)
  // Used by tool.ts and map.ts (tool-type workers) — non-LLM direct invocation
  resolveAndExecuteTool: (
    toolSource: ToolSource,
    toolName: string,
    args: Record<string, unknown>,
    agentId?: string,
  ) => Promise<TaintedToolResult | unknown>;

  // REMOVED: executeToolCall — replaced by resolveAndExecuteTool above
  // REMOVED: loadAgentTools — replaced by resolveTools above

  executeAgent: (...) => Promise<Action>;
  executeSupervisor: (...) => Promise<Action>;
  loadAgent: (agentId: string) => Promise<AgentConfigShape>;
  getTaintRegistry: (memory: Record<string, unknown>) => Record<string, unknown>;
  // ...
}
```

**Tests:**
- Integration tests: graph with agents using `ToolSource[]` resolves and executes correctly
- Test `GraphRunner` cleanup (`closeAll` called even on error)
- Update all existing node executor tests for new DI interface

**Success criteria:**
- End-to-end workflow with MCP tools via `tools: ToolSource[]` works
- `GraphRunner` manages connection lifecycle
- No leaked MCP connections

> **Research Insights — Phase 3 Wiring**
>
> - **`tool` node type impact** (Architecture Strategist): The current `tool` node executor uses `executeToolCall(name, args)` directly. After removal, `tool` nodes need a strategy: either route through `MCPConnectionManager` with a synthetic `ToolSource`, or convert `tool` nodes to use inline tool definitions. This is a gap in the plan — decide and document.
> - **Inject via interface** (Architecture Strategist): Define `resolveTools` as a `ToolResolver` interface method, not a bare function. This makes DI cleaner and enables per-test stubs without mocking the entire connection manager.
> - **`AgentConfigShape` must update** (Pattern Recognition): `context.ts:41-45` defines `AgentConfigShape` with `tools: string[]`. This is used by node executors and must change to `ToolSource[]` in lockstep with Phase 3.

---

#### Phase 4: Validation + Architect Integration

**Goal**: Pre-flight validation of tool sources, Architect awareness of available servers.

**Files to modify:**
- `packages/orchestrator/src/runner/graph-runner.ts` — add async `validateToolSources()` pre-flight step
- `packages/orchestrator/src/architect/tools.ts` — add `architect_list_mcp_servers` tool
- `packages/orchestrator/src/architect/` — inject available server info into Architect system prompt

**Validation logic (async, runs before execution loop):**
```typescript
async function validateToolSources(
  graph: Graph,
  registry: MCPServerRegistry,
  agentRegistry: AgentRegistry,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  const servers = await registry.listServers();
  const serverIds = new Set(servers.map(s => s.id));

  for (const node of graph.nodes) {
    if (node.agent_id) {
      const agent = await agentRegistry.loadAgent(node.agent_id);
      if (!agent?.tools) continue;

      for (const source of agent.tools) {
        if (source.type === 'mcp' && !serverIds.has(source.server_id)) {
          errors.push({
            node_id: node.id,
            message: `Agent "${agent.name}" references MCP server "${source.server_id}" which is not registered`,
          });
        }
      }
    }
  }
  return errors;
}
```

**Architect integration:**
- **Convert `ARCHITECT_SYSTEM_PROMPT` from a static constant to a builder function:**
  ```typescript
  // packages/orchestrator/src/architect/prompts.ts (MODIFY)
  export function buildArchitectSystemPrompt(
    servers: Array<{ id: string; name: string; description?: string; tools: string[] }>,
  ): string {
    const serverList = servers.map(s =>
      `- "${s.id}" (${s.name}): ${s.tools.join(', ')}`
    ).join('\n');

    return `${BASE_ARCHITECT_PROMPT}

## Available MCP Servers
${serverList || 'No MCP servers registered.'}

## ToolSource Format
Agent tools must use this format:
- Built-in: { type: "builtin", name: "save_to_memory" }
- MCP: { type: "mcp", server_id: "<id from list above>", tools: ["tool_name"] }
Use only server IDs from the list above.`;
  }
  ```
- **Inject at call time in `generateWorkflow()`** — pass registry contents to the builder, replacing the static `ARCHITECT_SYSTEM_PROMPT` reference at `architect/index.ts:114`
- **`architect_list_mcp_servers` is OPTIONAL** — since the Architect uses single-shot `generateText()` (not an agentic loop), it cannot call tools during generation. The tool may be useful for other agents (e.g., supervisors exploring capabilities), but the Architect gets server info via the system prompt injection, not via tool calling.
- Security enforcement: `AgentConfigSchema` structurally prevents `transport` fields in `tools` (Zod rejects unknown keys)
- `architect_list_mcp_servers` MUST return only `{ id, name, description, available_tools[] }` — NEVER transport configs, headers, or env vars

**Tests:**
- Validation catches missing server IDs
- Validation passes for valid configs
- Architect generates valid `tools` referencing registered servers
- Zod rejects `tools` entries with inline transport configs

**Success criteria:**
- Invalid tools caught before execution
- Architect can discover and reference MCP servers
- No way to bypass the registry via agent configs

> **Research Insights — Phase 4 Validation & Architect**
>
> - **Generalize tool discovery** (Agent-Native Reviewer): `architect_list_mcp_servers` should be a general-purpose `list_my_tools` built-in available to any agent, not Architect-specific. Any agent with debugging or self-reflection needs should be able to discover what tools it has access to. The Architect gets this automatically plus server-level details.
> - **Validate at graph load, not just pre-flight** (Architecture Strategist): The existing `GraphValidator` in `packages/orchestrator/src/validation/` should also validate tool source references structurally, even before a registry is available (e.g., catch malformed `ToolSource` objects).

---

#### Phase 5a: Orchestrator-Postgres MCP Server Registry (MUST run before 5b)

**Goal**: Create the `mcp_servers` Postgres table and seed a `'default'` entry. This MUST exist before the agents.tools data migration in Phase 5b.

**Files to create:**
- `packages/orchestrator-postgres/src/drizzle-mcp-registry.ts` — Drizzle implementation of `MCPServerRegistry`

**Files to modify:**
- `packages/orchestrator-postgres/src/schema.ts` — add `mcp_servers` table
- `packages/orchestrator-postgres/drizzle/` — new migration file (table creation + default seed)
- `packages/orchestrator-postgres/src/index.ts` — export new implementation

**Schema:**
```typescript
export const mcpServers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),  // user-defined, e.g. "search", "filesystem"
  name: text('name').notNull(),
  description: text('description'),
  transport: jsonb('transport').notNull().$type<MCPTransportConfig>(),
  allowed_agents: jsonb('allowed_agents').$type<string[] | null>(),
  timeout_ms: integer('timeout_ms').notNull().default(30000),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

**Seed migration (same transaction as table creation):**
```sql
-- Seed a 'default' server entry for legacy tool migration
-- Operators must update this transport config to match their environment
INSERT INTO mcp_servers (id, name, description, transport, timeout_ms)
VALUES (
  'default',
  'Default MCP Server (Legacy)',
  'Placeholder for tools migrated from string[] format. Update transport config.',
  '{"type": "http", "url": "http://localhost:3001/mcp"}'::jsonb,
  30000
) ON CONFLICT (id) DO NOTHING;
```

**Tests:**
- CRUD operations on `mcp_servers` table
- `loadServer()` returns null for missing ID
- `listServers()` returns all entries
- `'default'` server exists after migration

**Success criteria:**
- `mcp_servers` table exists with `'default'` entry
- MCP server configs persist across restarts
- Same interface as `InMemoryMCPServerRegistry`

---

#### Phase 5b: Clean Break — Delete Old Code, Update Schema + Exports

**Goal**: Remove the old MCP gateway code, update the Postgres schema, and update barrel exports. No backward compatibility — clean cut.

> **DEPENDS ON Phase 5a**: The `mcp_servers` table and `'default'` entry MUST exist before running the agents.tools data migration.

**Files to delete:**
- `packages/orchestrator/src/mcp/gateway-client.ts` — replaced by `@ai-sdk/mcp` via `MCPConnectionManager`
- `packages/orchestrator/src/mcp/json-schema-converter.ts` — handled internally by `@ai-sdk/mcp`
- `packages/orchestrator/src/mcp/tool-adapter.ts` — replaced by `MCPConnectionManager.resolveTools()`
- `packages/orchestrator/test/mcp-gateway.test.ts` — tests for deleted code
- `packages/orchestrator/test/tool-adapter.test.ts` — tests for deleted code
- `packages/orchestrator/test/json-schema-converter.test.ts` — tests for deleted code

**Files to modify:**
- `packages/orchestrator-postgres/src/schema.ts` — change `tools` column type from `$type<string[]>()` to `$type<ToolSource[]>()`
- `packages/orchestrator-postgres/drizzle/` — migration that transforms existing data
- `packages/orchestrator/src/index.ts` — replace old MCP exports with new ones

**Postgres migration (UP):**

> **PREREQUISITE**: The `mcp_servers` table (Phase 5b) MUST be created and a `'default'` server seeded BEFORE this migration runs. See Phase 5b below.

```sql
-- Idempotency guard: only transform rows still in string[] format
-- (jsonb_typeof checks the first element — 'string' means old format, 'object' means already migrated)
UPDATE agents SET tools = (
  SELECT jsonb_agg(
    CASE
      WHEN elem IN ('save_to_memory') THEN jsonb_build_object('type', 'builtin', 'name', elem)
      WHEN elem LIKE 'architect_%' THEN jsonb_build_object('type', 'builtin', 'name', elem)
      ELSE jsonb_build_object('type', 'mcp', 'server_id', 'default', 'tools', jsonb_build_array(elem))
    END
  )
  FROM jsonb_array_elements_text(tools) AS elem
) WHERE tools IS NOT NULL
  AND jsonb_array_length(tools) > 0
  AND jsonb_typeof(tools->0) = 'string';  -- skip already-migrated rows
```

**Postgres migration (DOWN):**
```sql
-- Reverse: convert ToolSource[] back to string[]
UPDATE agents SET tools = (
  SELECT jsonb_agg(tool_name)
  FROM (
    SELECT CASE
      WHEN elem->>'type' = 'builtin' THEN to_jsonb(elem->>'name')
      WHEN elem->>'type' = 'mcp' THEN t.val
    END AS tool_name
    FROM jsonb_array_elements(tools) AS elem
    LEFT JOIN LATERAL jsonb_array_elements(elem->'tools') AS t(val) ON elem->>'type' = 'mcp'
  ) sub
  WHERE tool_name IS NOT NULL
) WHERE tools IS NOT NULL
  AND jsonb_array_length(tools) > 0
  AND jsonb_typeof(tools->0) = 'object';  -- only reverse migrated rows
```

**Post-migration verification (REQUIRED):**
```sql
-- 1. No bare strings remain
SELECT id, name FROM agents WHERE tools IS NOT NULL
AND EXISTS (SELECT 1 FROM jsonb_array_elements(tools) elem WHERE jsonb_typeof(elem) != 'object');

-- 2. All entries have valid type
SELECT id, name FROM agents WHERE tools IS NOT NULL
AND EXISTS (SELECT 1 FROM jsonb_array_elements(tools) elem
  WHERE elem->>'type' NOT IN ('builtin', 'mcp') OR elem->>'type' IS NULL);

-- 3. All MCP entries have server_id
SELECT id, name FROM agents WHERE tools IS NOT NULL
AND EXISTS (SELECT 1 FROM jsonb_array_elements(tools) elem
  WHERE elem->>'type' = 'mcp' AND elem->>'server_id' IS NULL);
```

**Pre-migration analysis (run before migration to validate CASE coverage):**
```sql
SELECT DISTINCT elem AS tool_name, COUNT(*) AS agent_count
FROM agents, jsonb_array_elements_text(tools) AS elem
WHERE elem != 'save_to_memory' AND elem NOT LIKE 'architect_%'
GROUP BY elem ORDER BY agent_count DESC;
```

**Updated barrel exports:**
```typescript
// packages/orchestrator/src/index.ts — MCP section replacement

// MCP Integration
export { MCPConnectionManager } from './mcp/connection-manager.js';
export { ToolSourceSchema, MCPServerEntrySchema, MCPTransportConfigSchema } from './types/tools.js';
export type { ToolSource, MCPServerEntry, MCPTransportConfig } from './types/tools.js';
export { MCPGatewayError, MCPToolExecutionError, MCPServerNotFoundError, MCPAccessDeniedError } from './mcp/errors.js';
```

**Update all examples:**
- `examples/research-and-write/` — change `tools: []` to `tools: [{ type: 'builtin', name: 'save_to_memory' }]`
- `examples/supervisor-routing/` — same update

**Tests:**
- Verify old MCP exports are gone (import should fail)
- Postgres migration transforms existing rows correctly
- Examples still run with new tool format

**Success criteria:**
- No references to `MCPGatewayClient`, `loadAgentTools`, `executeToolCall`, or `jsonSchemaToZod` remain in codebase
- All barrel exports are clean — no deprecated markers, no dead code
- `npm test` passes in both workspaces

> **Research Insights — Phase 5 Migration & Cleanup**
>
> - **Phantom `'default'` server_id** (Data Migration Expert): The migration SQL maps unknown tool strings to `{ type: 'mcp', server_id: 'default', ... }`. This `'default'` server must exist in the registry or every migrated agent will fail validation. **Action**: Either (a) seed a `'default'` MCP server entry in the same migration, or (b) use a different migration strategy that maps to a known server ID from the user's environment.
> - **Add a DOWN migration** (Data Migration Expert): Include a reverse migration that converts `ToolSource[]` back to `string[]` for rollback safety:
>   ```sql
>   UPDATE agents SET tools = (
>     SELECT jsonb_agg(
>       CASE
>         WHEN elem->>'type' = 'builtin' THEN elem->>'name'
>         WHEN elem->>'type' = 'mcp' THEN (SELECT jsonb_agg(t) FROM jsonb_array_elements_text(elem->'tools') t)
>       END
>     )
>     FROM jsonb_array_elements(tools) AS elem
>   ) WHERE tools IS NOT NULL;
>   ```
> - **Add verification SQL** (Data Migration Expert): Post-migration verification query to confirm no rows have invalid `ToolSource` structures:
>   ```sql
>   SELECT id, name FROM agents WHERE tools IS NOT NULL
>   AND EXISTS (
>     SELECT 1 FROM jsonb_array_elements(tools) elem
>     WHERE elem->>'type' NOT IN ('builtin', 'mcp')
>       OR (elem->>'type' = 'mcp' AND elem->>'server_id' IS NULL)
>   );
>   ```
> - **Reorder: run migration AFTER registry is seeded** (Data Migration Expert): Phase 5 should depend on Phase 6 (Postgres registry) being available, or the migration should be deferred until the registry has entries. Consider reordering to Phase 5 → create `mcp_servers` table, Phase 6 → migrate `agents.tools` data.

---

## Alternative Approaches Considered

### 1. Graph-Level MCP Server Declarations

Declaring `mcp_servers` on the graph definition rather than in a separate registry. Rejected because:
- Tools are agent-specific, not graph-specific — different agents in the same graph may need different servers
- Embeds transport configs in graph definitions, which are potentially Architect-generated (security concern)
- Conflates graph structure (what to do) with infrastructure (how to connect)

### 2. Keep the Custom Gateway, Add Multi-Server Support

Extending `MCPGatewayClient` to support multiple gateway URLs. Rejected because:
- Still requires running a separate gateway service
- Duplicates what `@ai-sdk/mcp` provides natively
- Gateway adds latency without adding value (auth/audit can be done at the registry level)

### 3. Inline Transport Configs in Agent Configs

Letting agent configs contain full transport configurations. Rejected because:
- Security violation: agent configs are potentially LLM-generated or stored in shared databases
- A `stdio` transport config is essentially a shell command — this enables arbitrary code execution
- HTTP URLs in agent configs could exfiltrate data to attacker-controlled servers

## System-Wide Impact

### Interaction Graph

```
AgentConfig.tools (ToolSource[])
  → MCPConnectionManager.resolveTools()
    → MCPServerRegistry.getServer() (access control check)
      → @ai-sdk/mcp createMCPClient() (connection)
        → client.tools() (tool discovery)
          → taint-wrap execute callbacks
            → merged ToolSet
              → streamText({ tools }) (AI SDK execution)
                → tool.execute() callback fires
                  → MCP server processes request
                    → TaintedToolResult returned
                      → reducer processes Action
                        → state updated with taint registry
```

### Error & Failure Propagation

| Error | Source | Handling |
|---|---|---|
| Server not in registry | `MCPConnectionManager.getClient()` | Throws `MCPServerNotFoundError` → caught by node executor → workflow fails with clear message |
| Server unreachable | `createMCPClient()` | If `required: true` → `MCPConnectionError` → workflow fails. If `required: false` → warning logged, tools skipped |
| Access denied | `MCPConnectionManager.getClient()` | Throws `MCPAccessDeniedError` → workflow fails (security violation, no retry) |
| Tool execution error | MCP server via `@ai-sdk/mcp` | `CallToolError` → caught by AI SDK → reported to LLM as tool error → LLM can retry or proceed |
| Connection drops mid-workflow | `@ai-sdk/mcp` transport | Tool execute callback fails → AI SDK reports error → agent can retry tool call |
| Tool name collision | `resolveTools()` | Prevented by `{server_id}/{tool_name}` namespacing |

### State Lifecycle Risks

- **Partial connection failure**: If `closeAll()` throws for one client, remaining clients may leak. Mitigation: iterate all clients with individual try-catch, log errors, continue cleanup.
- **Taint registry consistency**: If a tool call succeeds but taint write fails, result is in state without provenance. Mitigation: taint wrapping happens inside the execute callback, before the result reaches the reducer.
- **No dual-field ambiguity**: The `tools` field is changed in-place from `string[]` to `ToolSource[]`. No coexistence of old and new formats.

### API Surface Parity

| Current Export | Replacement | Status |
|---|---|---|
| `MCPGatewayClient` | `MCPConnectionManager` | Deleted |
| `createMCPClient` (custom) | `@ai-sdk/mcp` `createMCPClient` | Deleted |
| `mcpClient` (singleton) | Per-workflow `MCPConnectionManager` instance | Deleted |
| `loadAgentTools(string[])` | `MCPConnectionManager.resolveTools(ToolSource[])` | Replaced |
| `executeToolCall(name, args)` | Built into AI SDK tool execute callbacks | Deleted |
| `jsonSchemaToZod()` | Handled by `@ai-sdk/mcp` internally | Deleted |
| `ToolDefinition` type | AI SDK `Tool` type | Deleted |

### Integration Test Scenarios

1. **Multi-server tool resolution**: Agent with `tools` referencing two MCP servers. Both resolve. Tools from both servers available. LLM calls one tool from each server. Both results taint-tracked with correct `server_id`.

2. **Partial server failure with mixed required/optional**: Agent has required server A and optional server B. Server B is down. Agent runs with only server A's tools. Warning logged. Workflow completes.

3. **Access control rejection**: Agent "writer" tries to use server restricted to `allowed_agents: ["researcher"]`. `MCPAccessDeniedError` thrown. Workflow fails with clear security message. No connection attempt made to the server.

4. **Connection cleanup on workflow error**: Workflow fails mid-execution. `GraphRunner` `finally` block calls `connectionManager.closeAll()`. All MCP connections closed. No leaked child processes (stdio) or open HTTP connections.

## Cross-Cutting Research Insights

> **Simplification Opportunities** (Simplicity Reviewer):
> Consider collapsing Phases 1-3 into a single phase and Phases 4-6 into a second phase. The type definitions, connection manager, and GraphRunner wiring are tightly coupled — shipping them separately creates intermediate states that don't compile. Phase boundaries should be at natural integration points, not artificial module boundaries.

> **Security Considerations** (Architecture Strategist):
> - Verify that `@ai-sdk/mcp` does not log or expose transport credentials (headers, env vars) in error messages or stack traces.
> - Stdio transports execute commands on the host — ensure the registry validates `command` against an allowlist, even though the registry itself is admin-controlled.
> - Consider adding a `max_concurrent_connections` field to `MCPServerEntry` to prevent resource exhaustion from parallel workflows.

> **Testing Strategy** (TypeScript Reviewer, Pattern Recognition):
> - Create a shared test fixture factory for `ToolSource[]` and `MCPServerEntry` objects to avoid duplication across test files.
> - Mock `@ai-sdk/mcp` at the module level using Vitest's `vi.mock()` — don't rely on integration tests with real MCP servers for unit-level coverage.
> - Add a "smoke test" that verifies the full resolution chain: `ToolSource[] → MCPConnectionManager → ToolSet → streamText` with all mocked dependencies.

## Acceptance Criteria

### Functional Requirements

- [ ] `MCPServerRegistry` interface with `InMemoryMCPServerRegistry` implementation
- [ ] `MCPConnectionManager` resolves `tools` into AI SDK-compatible `ToolSet`
- [ ] Multiple MCP servers supported simultaneously (HTTP, SSE, stdio transports)
- [ ] Tool names namespaced as `{server_id}/{tool_name}` to prevent collisions
- [ ] Built-in tools (`save_to_memory`, `architect_*`) work alongside MCP tools
- [ ] `GraphRunner` manages MCP connection lifecycle (connect lazily, close in finally)
- [ ] Pre-flight validation checks all `tools` server IDs exist in registry
- [ ] Architect can discover available MCP servers via `architect_list_mcp_servers` tool
- [ ] All existing agent configs updated to `ToolSource[]` format

### Security Requirements

- [ ] Agent configs cannot contain transport configurations (Zod schema rejection)
- [ ] `MCPServerEntry.allowed_agents` enforced — agents can only access permitted servers
- [ ] All MCP tool results wrapped with `TaintedToolResult` including `server_id` provenance
- [ ] Taint propagation unchanged — derived taint still flows through agent responses
- [ ] No secrets in agent configs — auth headers live only in registry entries

### Non-Functional Requirements

- [ ] `@ai-sdk/mcp` added as peer dependency (not bundled)
- [ ] MCP connections reused within a workflow run (not re-created per agent execution)
- [ ] Graceful degradation for `required: false` tool sources
- [ ] All existing tests pass after refactor
- [ ] New tests for every new module (registry, connection manager, validation)

### Quality Gates

- [ ] Old MCP gateway code fully removed (no dead code)
- [ ] `npm test` passes in both `orchestrator` and `orchestrator-postgres` workspaces
- [ ] Example workflow demonstrating multi-server MCP usage added to `examples/`

## Dependencies & Prerequisites

| Dependency | Why | Status |
|---|---|---|
| `@ai-sdk/mcp` package | Native MCP client for AI SDK | Not yet installed |
| `ai@^6.0.116` | Peer dependency, already present | Installed |
| Vercel AI SDK v6 `tool()` and `streamText` | Core execution primitives | Already used |
| `@ai-sdk/mcp/mcp-stdio` | Stdio transport (optional) | Bundled with `@ai-sdk/mcp` |

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@ai-sdk/mcp` API changes (still has experimental prefix in some imports) | Medium | High | Pin to specific version. Wrap in thin adapter if needed. |
| Tool namespacing (`server_id/tool_name`) confuses LLMs | Low | Medium | Test with multiple models. Use descriptive server IDs. Fall back to unnamespaced if single server. |
| Stdio process leaks on crash | Medium | Medium | `closeAll()` in finally block. Process monitoring. Timeout-based cleanup. |
| Performance regression from per-server connections vs single gateway | Low | Low | Connection reuse within workflow. Lazy connection (only connect when needed). |
| Postgres data migration | Low | Medium | In-place transform of `tools` column data. Test migration against snapshot of existing rows. |

## References & Research

### Internal References

- Current MCP gateway client: `packages/orchestrator/src/mcp/gateway-client.ts`
- Current tool adapter: `packages/orchestrator/src/mcp/tool-adapter.ts`
- Agent config schema: `packages/orchestrator/src/agent/types.ts:22`
- Executor DI interface: `packages/orchestrator/src/runner/node-executors/context.ts:54`
- GraphRunner wiring: `packages/orchestrator/src/runner/graph-runner.ts:325-341`
- Persistence interfaces: `packages/orchestrator/src/persistence/interfaces.ts:233`
- DB schema: `packages/orchestrator-postgres/src/schema.ts:150`
- Security docs: `apps/docs/src/content/docs/security.md`
- Adding tools guide: `apps/docs/src/content/docs/guides/adding-tools.md`

### External References

- AI SDK MCP Tools: https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
- AI SDK createMCPClient: https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client
- AI SDK Tools foundation: https://ai-sdk.dev/docs/foundations/tools
- MCP Security Best Practices: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- MCP Authorization Spec (Draft): https://modelcontextprotocol.io/specification/draft/basic/authorization
- OWASP MCP Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html
- OWASP AI Agent Security: https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html
