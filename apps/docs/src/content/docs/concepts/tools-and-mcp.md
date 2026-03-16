---
title: Tools & MCP
description: How agents interact with external systems via tool sources and the Model Context Protocol.
---

Agents need tools to interact with the world. MC-AI uses structured **tool sources** and the **Model Context Protocol (MCP)** for secure, standardized tool integration. This decouples the agent definition from the underlying transport configuration and connection secrets.

## Tool source types

Agents declare their tools using a `ToolSource[]` array with two possible types:

1. **Built-in tools**: Provided by the orchestrator itself. No external connection needed.
2. **MCP tools**: Provided by a registered MCP server. References the server by ID.

```typescript
import { InMemoryAgentRegistry } from '@mcai/orchestrator';

const agentRegistry = new InMemoryAgentRegistry();

const RESEARCH_AGENT = agentRegistry.register({
  name: 'Research Specialist',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  system_prompt: 'You are a research specialist...',
  tools: [
    { type: 'builtin', name: 'save_to_memory' },
    { type: 'mcp', server_id: 'web-search' }
  ],
});
```

Optionally, you can filter to specific tools from an MCP server by providing `tool_names`:

```typescript
{
  type: 'mcp',
  server_id: 'web-search',
  tool_names: ['search', 'fetch']
}
```

### Node-level tool overrides

Graph nodes can override an agent's configured tools for a specific execution step. This lets you reuse the same general-purpose agent with different contextual tool sets throughout a graph.

```typescript
{
  id: 'initial-research',
  type: 'agent',
  agent_id: RESEARCH_AGENT,
  tools: [
    { type: 'builtin', name: 'save_to_memory' },
    { type: 'mcp', server_id: 'web-search' },
    { type: 'mcp', server_id: 'twitter-search' }
  ],
  read_keys: ['goal'],
  write_keys: ['initial_notes'],
}
```

## MCP Server Registry

The **trusted MCP Server Registry** holds transport configurations and connection secrets. This is the security boundary — agents reference servers by ID, but never see connection details.

### Registering servers

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
    headers: {
      'Authorization': `Bearer <API_KEY>`,
    },
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

*(Note: For production environments, use `DrizzleMCPServerRegistry` from `@mcai/orchestrator-postgres` to store server configurations durably in the database.)*

### Transport types

| Transport | Use case | Security |
|-----------|----------|----------|
| `stdio` | Local MCP server processes | Command allowlist: `npx`, `node`, `python3`, `python`, `uvx` |
| `http` | Remote MCP servers (stateless) | HTTPS URLs only in production |
| `sse` | Remote MCP servers (streaming) | HTTPS URLs only in production |

### Access control

You can restrict which agents are allowed to use a specific server with the `allowed_agents` field:

```typescript
mcpRegistry.register({
  id: 'admin-tools',
  name: 'Admin Tools',
  transport: { type: 'http', url: 'https://internal.example.com/admin' },
  allowed_agents: ['admin-agent-001', 'ops-agent-002'],
});
```

When `allowed_agents` is set, only the listed agents can resolve tools from that server. Omit the field for unrestricted access.

## Taint tracking

All results returned from MCP tools are automatically wrapped with "taint" metadata before being stored in the graph's state. This allows downstream nodes to verify data provenance.

```typescript
{
  result: { /* original tool result */ },
  taint: {
    source: 'mcp_tool',
    tool_name: 'search',
    server_id: 'web-search',
    created_at: '2026-03-10T14:32:01.000Z',
  }
}
```

Downstream nodes can check taint status before trusting inputs. See the [Security](/security/) documentation for details on taint tracking and authorization.

## Next steps

- [Adding MCP Tools](/guides/adding-tools/) — wiring tools into the execution pipeline and building custom MCP servers
- [Agents](/concepts/agents/) — how agents use tools
- [Nodes](/concepts/nodes/) — node-level tool overrides
- [Security](/security/) — access control and taint tracking
