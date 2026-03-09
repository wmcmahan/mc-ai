---
title: Map-Reduce
description: Process large datasets by mapping work across parallel agents and reducing results.
---

The Map-Reduce pattern processes a collection of items by distributing work across parallel worker nodes and then aggregating the results with a synthesizer node.

## How it works

```
Input: [item1, item2, item3, ..., itemN]
         ↓         ↓         ↓
      Map(1)    Map(2)    Map(3)      (parallel)
         ↓         ↓         ↓
                Reduce                (aggregation)
                   ↓
                Output
```

## Configuration

```typescript
{
  id: 'process',
  type: 'map',
  map_reduce_config: {
    worker_node_id: 'analyzer',          // Node ID to fan out to for each item
    items_path: 'documents',             // Memory key holding the array to map over
    synthesizer_node_id: 'summarizer',   // Node to pass collected results to (optional)
    error_strategy: 'best_effort',       // 'fail_fast' | 'best_effort'
    max_concurrency: 5,                  // Max parallel worker executions
  },
  read_keys: ['documents'],
  write_keys: ['analysis_results'],
  failure_policy: { max_retries: 2 },
}
```

## Example: Document analysis pipeline

```typescript
// Initial state
const initialState = {
  goal: 'Analyze quarterly reports',
  memory: {
    documents: [
      { id: 'q1', content: 'Q1 2025 earnings...' },
      { id: 'q2', content: 'Q2 2025 earnings...' },
      { id: 'q3', content: 'Q3 2025 earnings...' },
      { id: 'q4', content: 'Q4 2025 earnings...' },
    ],
  },
};

// Each document is processed by analyzer-agent in parallel
// Results are collected and passed to summarizer-agent
// Final output: analysis_results = { summary: '...', trends: [...] }
```

## The worker agent

The worker node receives a single item from the collection in `_map_item`:

```json
{
  "id": "analyzer-agent",
  "model": "claude-haiku-4-5-20251001",
  "system": "Analyze the document in _map_item. Extract key metrics, sentiment, and notable events. Return structured JSON."
}
```

Using a faster, cheaper model (like Haiku) for map workers is often the right call — they're doing focused, parallel work, not complex reasoning.

## The synthesizer node

The synthesizer node receives the full array of worker outputs in `_map_results`:

```json
{
  "id": "summarizer-agent",
  "model": "claude-sonnet-4-20250514",
  "system": "You receive an array of document analyses in _map_results. Synthesize them into a comprehensive summary identifying overall trends, anomalies, and key takeaways."
}
```

The synthesizer can be any node type — a `synthesizer` node (LLM aggregation) or even a `supervisor` for complex post-processing.

## Concurrency and rate limits

`max_concurrency` controls how many map workers run simultaneously. Set this based on:
- Your LLM provider's rate limits
- The size of your items
- How much parallelism your infrastructure supports

With `error_strategy: 'best_effort'`, failed map executions are skipped and the reduce agent receives results from the successful ones. Use this when partial results are acceptable.

## When to use this pattern

Use Map-Reduce when:
- You have a collection of independent items to process (documents, URLs, records)
- Processing can be parallelized without dependencies between items
- You need to aggregate individual results into a summary
- The dataset is too large for a single agent's context window

For ordered, sequential processing, use a linear pipeline instead.
