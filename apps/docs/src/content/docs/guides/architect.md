---
title: Using the Architect
description: Generate workflow graphs from natural language prompts.
---

Instead of hand-writing graph JSON, the **Workflow Architect** lets an LLM generate valid graph definitions from a natural language description.

## Generate a workflow programmatically

```typescript
import { generateWorkflow } from '@mcai/orchestrator';

const { graph, metadata } = await generateWorkflow({
  prompt: 'Monitor Hacker News for AI news, summarize daily, post to Slack',
});

console.log(graph.name);           // "HN AI Monitor"
console.log(graph.nodes.length);   // 3
console.log(metadata.attempts);    // 1
console.log(metadata.warnings);    // []
```

The generated graph is validated against the `GraphSchema` — if it has invalid edges or missing nodes, the Architect automatically feeds validation errors back to the LLM and retries (up to 2 times).

## Iterative refinement

Refine an existing graph with a follow-up prompt:

```typescript
const { graph: updatedGraph } = await generateWorkflow({
  prompt: 'Add a Slack notification step after the summarizer',
  current_graph: existingGraph,
});
```

The Architect preserves all existing nodes/edges and applies your change.

## Architect as an agent

Give the Architect's tools to an agent and let it manage workflows autonomously:

### 1. Initialize at startup

```typescript
import { initArchitectTools } from '@mcai/orchestrator';

initArchitectTools({
  saveGraph: (graph) => db.graphs.upsert(graph),
  loadGraph: (id) => db.graphs.findById(id),
});
```

### 2. Configure the agent

```json
{
  "id": "ops-manager",
  "name": "Ops Manager",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "system_prompt": "You manage automation workflows. Use your tools to create, update, and inspect workflows.",
  "tools": [
    "architect_draft_workflow",
    "architect_publish_workflow",
    "architect_get_workflow"
  ]
}
```

### 3. Use it conversationally

The agent handles the full **Draft → Review → Publish** loop:

```
You:   "We need a workflow that scrapes competitors' pricing pages and sends a Slack summary"
Agent: [calls architect_draft_workflow] → generates graph
Agent: "Here's what I designed: 3 nodes (scraper → analyzer → notifier)..."
You:   "Add error retries to the scraper node"
Agent: [modifies graph] → updated
Agent: "Updated. Want me to publish it?"
You:   "Yes"
Agent: [calls architect_publish_workflow] → saved to registry
```

## Architect tools

| Tool | Description |
|------|-------------|
| `architect_draft_workflow` | Generate a graph from a prompt (optionally refine an existing graph) |
| `architect_publish_workflow` | Save a graph to the registry |
| `architect_get_workflow` | Load an existing graph by ID |

## Next steps

- [Graphs & Nodes](/concepts/graphs-and-nodes/) — understand the graph format the Architect generates
- [Supervisor](/patterns/supervisor/) — combine the Architect with supervisor routing
