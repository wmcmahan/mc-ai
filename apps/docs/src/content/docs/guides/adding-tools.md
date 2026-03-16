---
title: Adding MCP Tools
description: Wire MCP tools into your workflow execution pipeline and build custom MCP servers.
---

This guide covers the practical steps for connecting tools to a running workflow. For background on tool source types, the MCP Server Registry, transport configuration, and taint tracking, see [Tools & MCP](/concepts/tools-and-mcp/).

## Wiring into the execution pipeline

To execute a workflow with MCP tools, inject an `MCPConnectionManager` (configured with your registry) into the `GraphRunner`.

```typescript
import { GraphRunner, MCPConnectionManager } from '@mcai/orchestrator';

async function runWorkflow(state) {
  // 1. Create the resolver with your configured registry
  const toolResolver = new MCPConnectionManager(mcpRegistry);

  // 2. Inject it into the runner alongside your agent registry
  const runner = new GraphRunner(graph, state, {
    agentRegistry,
    toolResolver,
    persistStateFn: async (s) => { /* persist state hook */ },
  });

  try {
    const result = await runner.run();
    return result;
  } finally {
    // 3. Always clean up connections!
    await toolResolver.closeAll();
  }
}
```

## Developing custom MCP servers

Before building a custom server, check the [MCP community registry](https://github.com/modelcontextprotocol/servers) to see if an integration already exists.

To build your own custom MCP server using the `@modelcontextprotocol/sdk`:

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

Once built, [register your server's transport configuration](/concepts/tools-and-mcp/#registering-servers) in the MCP Server Registry and reference it from your agent configurations.

## Next steps

- [Tools & MCP](/concepts/tools-and-mcp/) — tool sources, MCP registry, transport types, taint tracking
- [Agents](/concepts/agents/) — how agents use tools
- [Using the Architect](/guides/architect/) — generate workflows with tool declarations
