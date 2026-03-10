---
title: Security
description: Zero Trust model, sandboxing, state slicing, and taint tracking.
---

MC-AI operates under a **Zero Trust** model. We assume:

1. **Input is malicious** — users and external data will try to inject attacks
2. **Agents are fallible** — LLMs can be jailbroken or duped
3. **State is leaky** — agents should only know what they need to know

## State slicing (least privilege)

Agents are denied access to the global `WorkflowState` by default. Each agent declares its permissions:

```typescript
{
  read_keys: ['goal', 'notes'],  // Can only read these keys
  write_keys: ['draft'],          // Can only write this key
}
```

The orchestrator creates a filtered view — an agent trying to access `state.db_credentials` receives `undefined` unless explicitly authorized.

## Taint tracking

The most dangerous attack vector: an agent reads a malicious website.

- **Flagging**: Any string entering the system from an external tool (web search, file read) is marked as **tainted**
- **Propagation**: If a node reads tainted data and writes to state, the output key inherits the taint flag
- **Downstream decisions**: Critical nodes can check taint status before trusting their inputs

## Economic guardrails

Prevent infinite loops and "denial of wallet" attacks:

| Guard | Default |
|-------|---------|
| **Global budget** | Per-run cap (e.g., $1.00 or 50k tokens) |
| **Step limit** | Max 50 total graph iterations (`max_iterations`) |
| **Execution timeout** | Configurable via `max_execution_time_ms` |
| **Recursive depth** | Subgraphs cannot nest beyond 2 layers |

## Immutable history

Critical state transitions are logged as actions. Every state change is tied to:
- Which node produced it
- When it was applied
- What the previous state was

This enables full audit trails and time-travel debugging.

## Runtime isolation

For production deployments where agents execute untrusted code:

- **No local execution** — agents never run code on the host OS
- **Container isolation** — code execution happens in ephemeral containers (Docker, Firecracker, E2B)
- **Network isolation** — sandboxes have no access to internal networks

## Human-in-the-loop as security

For high-stakes actions:

1. The agent proposes an action but does not execute
2. The workflow pauses (via an `approval` node)
3. A human reviews and approves or rejects
4. Only then does execution continue

See [Human-in-the-Loop](/patterns/human-in-the-loop/) for the implementation pattern.

## MCP tool security

Agents never see MCP server transport configurations or secrets. The security model has two layers:

### Trusted MCP Server Registry

Server connection configs (URLs, commands, auth headers) live in the **MCP Server Registry** — an admin-only data store. Agent configs reference servers by ID only:

```json
// Agent config — references server by ID, no transport details
{ "type": "mcp", "server_id": "web-search" }
```

### Access control (`allowed_agents`)

Each server entry can restrict which agents may use it:

```typescript
{
  id: 'admin-tools',
  name: 'Admin Tools',
  transport: { type: 'http', url: 'https://internal.example.com/admin' },
  allowed_agents: ['admin-agent-001'],  // only this agent can access
}
```

When `allowed_agents` is set, an `MCPAccessDeniedError` is thrown if an unauthorized agent attempts to resolve tools from that server.

### Taint wrapping

All MCP tool results are automatically wrapped with taint metadata (source, tool name, server ID, timestamp). This enables downstream nodes to check provenance before trusting inputs.

### Transport restrictions

- **stdio**: Only allowlisted commands (`npx`, `node`, `python3`, `python`, `uvx`) — no arbitrary execution
- **http/sse**: URLs stored in the registry, not in agent configs — secrets stay server-side

## Next steps

- [Workflow State](/concepts/workflow-state/) — state slicing and taint details
- [Agents](/concepts/agents/) — agent permissions model
- [Tracing](/observability/tracing/) — audit workflow execution
