---
title: Adding MCP Tools
description: Give agents the ability to interact with external systems via Model Context Protocol.
---

Agents need tools to interact with the world. MC-AI uses the **Model Context Protocol (MCP)** for standardized tool integration.

## How it works

1. You list tool IDs in the agent's config
2. The orchestrator fetches tool definitions from the MCP gateway
3. Tools are converted to the AI SDK format automatically
4. When the agent calls a tool, the orchestrator executes it securely
5. The result is fed back to the agent loop

## Defining tools in agent config

```json
{
  "id": "research-agent",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "system_prompt": "You are a research specialist...",
  "tools": ["web_search", "fs_read_file"]
}
```

## MCP gateway

The MCP gateway acts as a proxy between agents and tool servers:

- **Routing**: Forwards requests to the correct MCP server
- **Security**: Validates that the agent is allowed to call the tool
- **Isolation**: Agents don't connect to MCP servers directly

## Developing custom tools

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

## Next steps

- [Agents](/concepts/agents/) — how agents use tools
- [Using the Architect](/guides/architect/) — generate workflows from natural language
- [Security](/security/) — tool firewalling and taint tracking
