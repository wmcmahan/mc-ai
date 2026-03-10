---
title: Adding MCP Tools
description: Give agents the ability to interact with external systems via Model Context Protocol.
---

Agents need tools to interact with the world. MC-AI uses structured **tool sources** and the **Model Context Protocol (MCP)** for secure, standardized tool integration.

## How it works

```
Agent Config (tools: ToolSource[])
  → MCPConnectionManager resolves tool sources
    → Built-in tools resolved directly
    → MCP tools: lookup server in registry → connect via @ai-sdk/mcp → fetch tools
  → Merged tool set passed to AI SDK
  → Results taint-wrapped for security
```

## Tool source types

Agents declare their tools as a `ToolSource[]` array with two types:

### Built-in tools

Provided by the orchestrator itself. No external connection needed.

```json
{ "type": "builtin", "name": "save_to_memory" }
```

Available built-in tools: `save_to_memory`, `architect_draft_workflow`, `architect_publish_workflow`, `architect_get_workflow`.

### MCP tools

Provided by a registered MCP server. References the server by ID — never contains transport config.

```json
{ "type": "mcp", "server_id": "web-search" }
```

Optionally filter to specific tools from the server:

```json
{ "type": "mcp", "server_id": "web-search", "tool_names": ["search", "fetch"] }
```

## Agent config example

```json
{
  "id": "research-agent",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "system_prompt": "You are a research specialist...",
  "tools": [
    { "type": "builtin", "name": "save_to_memory" },
    { "type": "mcp", "server_id": "web-search" }
  ]
}
```

## MCP Server Registry

The **trusted MCP Server Registry** holds transport configurations. This is the security boundary — agents reference servers by ID, but never see connection details or secrets.

### Register servers

```typescript
import { InMemoryMCPServerRegistry } from '@mcai/orchestrator';

const mcpRegistry = new InMemoryMCPServerRegistry();

// HTTP transport
mcpRegistry.register({
  id: 'web-search',
  name: 'Web Search',
  description: 'Search the web via Brave Search API',
  transport: {
    type: 'http',
    url: 'https://mcp.example.com/web-search',
    headers: { 'Authorization': 'Bearer ${process.env.SEARCH_API_KEY}' },
  },
});

// Stdio transport (local MCP server)
mcpRegistry.register({
  id: 'code-executor',
  name: 'Code Executor',
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@mcp/code-sandbox'],
    env: { SANDBOX_TIMEOUT: '30000' },
  },
});

// SSE transport
mcpRegistry.register({
  id: 'slack-tools',
  name: 'Slack Integration',
  transport: {
    type: 'sse',
    url: 'https://mcp.example.com/slack/sse',
  },
  timeout_ms: 60_000,
});
```

For production, use `DrizzleMCPServerRegistry` from `@mcai/orchestrator-postgres` to store server configs in the database.

### Access control

Restrict which agents can use a server with `allowed_agents`:

```typescript
mcpRegistry.register({
  id: 'admin-tools',
  name: 'Admin Tools',
  transport: { type: 'http', url: 'https://internal.example.com/admin' },
  allowed_agents: ['admin-agent-001', 'ops-agent-002'],
});
```

When `allowed_agents` is set, only listed agents can resolve tools from that server. Omit the field for unrestricted access.

### Transport types

| Transport | Use case | Security |
|-----------|----------|----------|
| `stdio` | Local MCP server processes | Command allowlist: `npx`, `node`, `python3`, `python`, `uvx` |
| `http` | Remote MCP servers (stateless) | HTTPS URLs only in production |
| `sse` | Remote MCP servers (streaming) | HTTPS URLs only in production |

## Wiring into GraphRunner

```typescript
import {
  GraphRunner,
  MCPConnectionManager,
  InMemoryMCPServerRegistry,
} from '@mcai/orchestrator';

const mcpRegistry = new InMemoryMCPServerRegistry();
// ... register servers ...

const toolResolver = new MCPConnectionManager(mcpRegistry);

const runner = new GraphRunner(graph, state, {
  persistStateFn: async (s) => { /* ... */ },
  toolResolver,  // enables MCP tool resolution
});

const result = await runner.run();
// toolResolver.closeAll() is called automatically in the finally block
```

## Node-level tool overrides

Graph nodes can override an agent's configured tools:

```typescript
const graph: Graph = {
  // ...
  nodes: [
    {
      id: 'research',
      type: 'agent',
      agent_id: 'general-agent',
      tools: [
        { type: 'builtin', name: 'save_to_memory' },
        { type: 'mcp', server_id: 'web-search' },
      ],
      read_keys: ['goal'],
      write_keys: ['notes'],
    },
  ],
};
```

When `tools` is set on a node, it overrides the agent config's tools for that execution. This lets you reuse the same agent with different tool sets in different parts of a graph.

## Taint tracking

All results from MCP tools are automatically wrapped with taint metadata:

```typescript
{
  result: { /* original tool result */ },
  taint: {
    source: 'mcp_tool',
    tool_name: 'search',
    server_id: 'web-search',
    created_at: '2026-03-10T...',
  }
}
```

Downstream nodes can check taint status before trusting inputs. See [Security](/security/) for details.

## Developing custom MCP servers

Check the [MCP community registry](https://github.com/modelcontextprotocol/servers) for existing servers before building your own.

To build a custom MCP server:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "company-api",
  version: "1.0.0",
});

server.tool("get_user", { id: z.string() }, async ({ id }) => {
  return db.users.find(id);
});

server.connect(transport);
```

Then register it in the MCP Server Registry and reference it from agent configs.

## Next steps

- [Agents](/concepts/agents/) — how agents use tools
- [Using the Architect](/guides/architect/) — generate workflows with tool declarations
- [Security](/security/) — access control and taint tracking
