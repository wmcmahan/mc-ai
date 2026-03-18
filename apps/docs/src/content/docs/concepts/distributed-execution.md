---
title: Distributed Execution
description: Scale workflow execution across multiple processes with per-workflow worker assignment.
---

MC-AI's `GraphRunner` runs entirely within a single Node.js process. For production deployments with concurrent workflows, the **WorkflowWorker** distributes execution across multiple processes — each workflow runs on one worker for its entire lifetime, using the existing `GraphRunner` unmodified.

## Architecture

```
                    ┌─────────────────────┐
                    │   WorkflowQueue      │
                    │  (waiting jobs)      │
                    └──────┬──────────────┘
                           │ dequeue
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼────┐ ┌────▼─────┐ ┌────▼─────┐
        │ Worker 1  │ │ Worker 2  │ │ Worker 3  │
        │ GraphRunner│ │ GraphRunner│ │ GraphRunner│
        └──────────┘ └──────────┘ └──────────┘
```

Workers poll the queue, claim jobs atomically, and execute workflows. Crashed workers are detected via **visibility timeouts** — if a worker stops heartbeating, the job is reclaimed and re-executed on another worker using event log replay.

## WorkflowQueue

The `WorkflowQueue` interface is the core abstraction. It provides SQS-style semantics with visibility timeouts, priority ordering, and dead-lettering.

```typescript
import { InMemoryWorkflowQueue } from '@mcai/orchestrator';

const queue = new InMemoryWorkflowQueue();

// Enqueue a new workflow
const jobId = await queue.enqueue({
  type: 'start',
  run_id: crypto.randomUUID(),
  graph_id: 'my-graph-id',
  initial_state: { goal: 'Research AI trends' },
  priority: 0,         // Lower = higher priority
  max_attempts: 3,     // Before dead-lettering
});
```

### Job lifecycle

```mermaid
stateDiagram-v2
  direction LR
  waiting --> active : dequeue (worker claims)
  active --> completed : ack (success)
  active --> waiting : nack (retry)
  active --> waiting : release (HITL pause)
  active --> waiting : reclaimExpired (crash)
  active --> dead_letter : nack (attempts exhausted)
```

### Queue methods

| Method | Description |
|--------|-------------|
| `enqueue(input)` | Add a job. Returns the auto-generated job ID. |
| `dequeue(workerId)` | Atomically claim the highest-priority waiting job. Returns `null` if empty. |
| `ack(jobId)` | Mark a job as completed (terminal success). |
| `nack(jobId, error)` | Report failure. Retries if attempts remain, otherwise dead-letters. |
| `heartbeat(jobId, extendMs?)` | Extend the visibility timeout during long execution. |
| `release(jobId)` | Return to queue **without** incrementing attempt count (for HITL pauses). |
| `reclaimExpired()` | Reclaim jobs with expired visibility timeouts (crash recovery). |
| `getJob(jobId)` | Load a job by ID (diagnostics). |
| `getQueueDepth()` | Count jobs by status: `{ waiting, active, dead_letter }`. |

### Key design: release vs nack

`release` is distinct from `nack` — HITL pauses call `release` to free the worker slot without penalizing the attempt count. The job returns to `waiting` and can be re-claimed later when the human responds.

## WorkflowWorker

The `WorkflowWorker` polls the queue and runs workflows using the existing `GraphRunner`:

```typescript
import {
  WorkflowWorker,
  InMemoryWorkflowQueue,
  InMemoryPersistenceProvider,
  InMemoryEventLogWriter,
} from '@mcai/orchestrator';

const worker = new WorkflowWorker({
  queue,
  persistence: new InMemoryPersistenceProvider(),
  eventLog: new InMemoryEventLogWriter(),
  concurrency: 2,           // Run up to 2 workflows simultaneously
  pollIntervalMs: 1000,     // Check for new jobs every second
  heartbeatIntervalMs: 60_000,  // Heartbeat every minute
  reclaimIntervalMs: 30_000,    // Check for crashed jobs every 30s
  shutdownGracePeriodMs: 30_000, // Wait 30s for in-flight work on stop
});

await worker.start();

// Later...
await worker.stop();  // Graceful shutdown
```

### Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `workerId` | `crypto.randomUUID()` | Unique worker identifier. |
| `queue` | *(required)* | `WorkflowQueue` to poll for jobs. |
| `persistence` | *(required)* | `PersistenceProvider` for loading graphs and saving state. |
| `eventLog` | *(required)* | `EventLogWriter` for durable execution and crash recovery. |
| `runnerOptionsFactory` | — | Factory for per-job `GraphRunnerOptions` (toolResolver, modelResolver, etc.). |
| `concurrency` | `1` | Maximum concurrent jobs per worker. |
| `pollIntervalMs` | `1000` | Polling interval in milliseconds. |
| `heartbeatIntervalMs` | `60000` | Heartbeat interval in milliseconds. |
| `reclaimIntervalMs` | `30000` | Interval for reclaiming expired jobs. |
| `shutdownGracePeriodMs` | `30000` | Grace period for in-flight work during shutdown. |

### Events

The worker extends `EventEmitter` and emits:

| Event | Payload | Description |
|-------|---------|-------------|
| `job:claimed` | `{ jobId, runId }` | Worker has claimed a job from the queue. |
| `job:completed` | `{ jobId, runId }` | Job finished successfully (acked). |
| `job:failed` | `{ jobId, runId, error }` | Job failed (nacked, will retry). |
| `job:released` | `{ jobId, runId }` | Job released for HITL pause. |
| `job:dead_letter` | `{ jobId, runId, error }` | Job exhausted all retries. |
| `worker:started` | `{ workerId }` | Worker poll loop has started. |
| `worker:stopped` | `{ workerId }` | Worker has shut down. |

## Crash recovery

When a worker crashes (or its process is killed), its in-flight jobs eventually expire via the visibility timeout. The reclaim timer on any running worker detects these expired jobs and returns them to `waiting`.

When another worker picks up the job, it checks the event log:

1. If events exist for the run → `GraphRunner.recover()` replays them to reconstruct state
2. If no events → fresh start with the job's `initial_state`

This means even `start` jobs are safely recoverable — if a worker crashes mid-execution, the next worker seamlessly continues from the last event.

## Human-in-the-Loop with workers

The worker handles HITL workflows without blocking:

```mermaid
sequenceDiagram
    participant API
    participant Queue
    participant Worker
    participant Human

    API->>Queue: enqueue({ type: 'start', ... })
    Queue->>Worker: dequeue
    Worker->>Worker: GraphRunner.run()
    Note over Worker: Hits approval node
    Worker->>Queue: release(jobId)
    Note over Worker: Worker is free for other jobs

    Human->>API: Submit decision
    API->>Queue: enqueue({ type: 'resume', human_response: {...} })
    Queue->>Worker: dequeue (same or different worker)
    Worker->>Worker: GraphRunner.recover() → applyHumanResponse() → run()
    Worker->>Queue: ack(jobId)
```

1. API enqueues a `start` job
2. Worker runs the workflow until it hits an approval node → `status: 'waiting'`
3. Worker calls `queue.release()` — frees the worker slot (no blocking)
4. Later, the API enqueues a `resume` job with the human's response
5. A worker picks it up, recovers via event log, applies the response, and continues

## Dead-lettering

When a job fails more times than `max_attempts`, it transitions to `dead_letter` status. Dead-lettered jobs are not retried — they require manual intervention.

Monitor dead-lettered jobs via `getQueueDepth()`:

```typescript
const depth = await queue.getQueueDepth();
if (depth.dead_letter > 0) {
  console.warn(`${depth.dead_letter} jobs in dead letter queue`);
}
```

## Metrics integration

The existing `setQueueDepthProvider()` works with the queue:

```typescript
import { setQueueDepthProvider } from '@mcai/orchestrator';

setQueueDepthProvider(async () => {
  const depth = await queue.getQueueDepth();
  return depth.waiting + depth.active;
});
```

## Implementations

| Implementation | Package | Use Case |
|---------------|---------|----------|
| `InMemoryWorkflowQueue` | `@mcai/orchestrator` | Testing, single-process deployments |
| `DrizzleWorkflowQueue` | `@mcai/orchestrator-postgres` | Production (uses `FOR UPDATE SKIP LOCKED`) — *coming soon* |

## Next steps

- [Persistence](/concepts/persistence/) — storage interfaces consumed by the worker
- [Error Handling](/concepts/error-handling/) — how errors propagate through workers
- [Human-in-the-Loop](/patterns/human-in-the-loop/) — HITL pattern details
- [Streaming](/concepts/streaming/) — real-time event consumption within a worker
