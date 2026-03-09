# Validation — Technical Reference

> **Scope**: This document covers the graph validation system in `@mcai/orchestrator`. It is intended for contributors modifying validation rules, adding checks for new node types, or integrating validation into new subsystems.

---

## Overview

The validation module provides structural integrity checks for `Graph` definitions before they are executed. It catches configuration errors (missing references, duplicate IDs) and warns about suspicious patterns (unreachable nodes, dead ends, cycles without end nodes).

| File | Purpose |
|------|---------|
| `graph-validator.ts` | `validateGraph()` function and `detectCycles()` helper |
| `index.ts` | Barrel re-export |

### Consumers

| Caller | When |
|--------|------|
| `GraphRunner.run()` | Before execution begins — invalid graphs are rejected immediately |
| `generateWorkflow()` | After LLM generates a graph — errors trigger self-correction loop |

---

## `validateGraph(graph): ValidationResult`

The main validation function. Runs all checks in a single pass with pre-built lookup structures for `O(N + E)` performance.

```typescript
import { validateGraph } from '@mcai/orchestrator';

const result = validateGraph(graph);
if (!result.valid) {
  console.error('Errors:', result.errors);
}
if (result.warnings.length > 0) {
  console.warn('Warnings:', result.warnings);
}
```

### Return Type

```typescript
interface ValidationResult {
  valid: boolean;     // true if no errors (warnings don't affect validity)
  errors: string[];   // Hard failures — graph cannot be executed
  warnings: string[]; // Suspicious but valid patterns
}
```

---

## Validation Checks

### Errors (Invalid Graph)

| Check | Condition | Example Message |
|-------|-----------|-----------------|
| **Duplicate node IDs** | Two nodes share the same `id` | `Duplicate node ID: 'research'` |
| **Start node missing** | `start_node` references non-existent node | `Start node 'start' not found in graph nodes` |
| **End node missing** | `end_nodes` contains non-existent ID | `End node 'finish' not found in graph nodes` |
| **Duplicate edge IDs** | Two edges share the same `id` | `Duplicate edge ID: 'e1'` |
| **Edge source missing** | Edge `source` references non-existent node | `Edge 'e1': source node 'foo' not found` |
| **Edge target missing** | Edge `target` references non-existent node | `Edge 'e1': target node 'bar' not found` |
| **Agent missing agent_id** | Agent node without `agent_id` | `Agent node 'research' is missing agent_id` |
| **Tool missing tool_id** | Tool node without `tool_id` | `Tool node 'search' is missing tool_id` |
| **Subgraph missing config** | Subgraph node without `subgraph_config` | `Subgraph node 'sub' is missing subgraph_config` |
| **Subgraph missing ID** | Subgraph config without `subgraph_id` | `Subgraph node 'sub' is missing subgraph_config.subgraph_id` |
| **Approval missing config** | Approval node without `approval_config` | `Approval node 'review' is missing approval_config` |
| **Approval bad rejection** | `rejection_node_id` references non-existent node | `Approval node 'review': rejection_node_id 'fix' not found` |
| **Map missing config** | Map node without `map_reduce_config` | `Map node 'fan-out' is missing map_reduce_config` |
| **Map bad worker** | `worker_node_id` references non-existent node | `Map node 'fan-out': worker node 'worker' not found` |
| **Map bad synthesizer** | `synthesizer_node_id` references non-existent node | `Map node 'fan-out': synthesizer node 'merge' not found` |
| **Voting missing config** | Voting node without `voting_config` | `Voting node 'consensus' is missing voting_config` |
| **Voting empty voters** | `voter_agent_ids` is empty | `Voting node 'consensus': voter_agent_ids must not be empty` |
| **Voting missing judge** | `llm_judge` strategy without `judge_agent_id` | `Voting node 'consensus': llm_judge strategy requires judge_agent_id` |
| **Supervisor missing config** | Supervisor node without `supervisor_config` | `Supervisor node 'router' is missing supervisor_config` |
| **Supervisor bad managed** | `managed_nodes` references non-existent node | `Supervisor 'router': managed node 'worker' not found` |
| **Swarm bad peer** | `peer_nodes` references non-existent node | `Swarm node 'agent-a': peer node 'agent-z' not found` |

### Warnings (Valid but Suspicious)

| Check | Condition | Example Message |
|-------|-----------|-----------------|
| **No end nodes** | `end_nodes` array is empty | `Graph has no end nodes — execution may only terminate via max_iterations or timeout` |
| **Self-referencing edge** | Edge where `source === target` | `Edge 'e1': self-referencing edge on node 'loop' (potential tight loop)` |
| **Empty condition** | Conditional edge with no expression | `Edge 'e1': conditional edge is missing a condition expression (will always evaluate to false)` |
| **Unreachable nodes** | Node not reachable via BFS from `start_node` | `Node 'orphan' is unreachable from start node` |
| **Dead-end nodes** | Non-end node with no outgoing edges | `Node 'stuck' has no outgoing edges and is not an end node (potential dead end)` |
| **Annealing temp inverted** | `initial_temperature < final_temperature` | `Agent node 'writer': annealing initial_temperature (0.2) is less than final_temperature (1.0) — temperature will increase instead of decrease` |
| **Swarm missing return** | Peer node has no edge back to swarm node | `Swarm node 'agent-a': no return edge from peer 'agent-b' (handoff back may not be possible)` |
| **Supervisor no edge to worker** | Supervisor has no outgoing edge to managed node | `Supervisor 'router' has no edge to managed node 'worker'` |
| **Self-managing supervisor** | Supervisor lists itself in `managed_nodes` | `Supervisor 'router' manages itself (potential infinite loop)` |
| **Cycles without end nodes** | Graph has cycles but no end nodes | `Graph contains cycles but has no end nodes (potential infinite loop)` |

---

## Cycle Detection

The `detectCycles()` function uses **iterative DFS** with a three-color marking scheme:

| Color | Meaning |
|-------|---------|
| WHITE (0) | Unvisited |
| GRAY (1) | In current DFS path (recursion stack) |
| BLACK (2) | Fully processed |

A cycle is detected when a GRAY node is encountered during traversal (back edge). The algorithm is iterative (uses an explicit stack) to avoid stack overflow on large or deeply-nested graphs.

---

## Performance

All node/edge lookups use pre-built `Map` structures for `O(1)` access:

| Structure | Purpose |
|-----------|---------|
| `nodeMap: Map<string, GraphNode>` | Node lookup by ID |
| `outgoingEdges: Map<string, GraphEdge[]>` | Adjacency list for BFS/cycle detection |
| `endNodeSet: Set<string>` | End node membership check |

Total complexity: `O(N + E)` where N = nodes, E = edges.

---

## Exports

```typescript
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateGraph(graph: Graph): ValidationResult;
```
