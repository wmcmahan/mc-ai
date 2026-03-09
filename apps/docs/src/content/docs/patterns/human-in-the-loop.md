---
title: Human-in-the-Loop
description: Pause workflows for human review with approval gates.
---

The **Human-in-the-Loop (HITL)** pattern allows workflows to pause mid-execution, wait for human input or approval, and resume exactly where they left off.

## How it works

1. An agent produces output (e.g., a draft document)
2. The workflow reaches an `approval` node and **pauses**
3. The workflow state is persisted with status `waiting`
4. A human reviews the output and approves or rejects
5. The workflow resumes from the approval node and continues

## Graph definition

```typescript
const hitlGraph: Graph = {
  id: 'hitl-example',
  name: 'Human-in-the-Loop',
  version: '1.0.0',
  nodes: [
    {
      id: 'writer',
      type: 'agent',
      agent_id: 'writer-agent',
      read_keys: ['goal'],
      write_keys: ['draft'],
      failure_policy: { max_retries: 2 },
      requires_compensation: false,
    },
    {
      id: 'review',
      type: 'approval',
      approval_config: {
        approval_type: 'human_review',
        prompt_message: 'Please review the draft and approve or reject.',
        review_keys: ['draft'],
        timeout_ms: 86_400_000,  // 24-hour timeout
      },
      read_keys: ['*'],
      write_keys: ['*'],
      failure_policy: { max_retries: 1 },
      requires_compensation: false,
    },
    {
      id: 'publisher',
      type: 'agent',
      agent_id: 'publisher-agent',
      read_keys: ['draft'],
      write_keys: ['published_url'],
      failure_policy: { max_retries: 1 },
      requires_compensation: false,
    },
  ],
  edges: [
    { id: 'e1', source: 'writer',  target: 'review',    condition: { type: 'always' } },
    { id: 'e2', source: 'review',  target: 'publisher', condition: { type: 'always' } },
  ],
  start_node: 'writer',
  end_nodes: ['publisher'],
  created_at: new Date(),
  updated_at: new Date(),
};
```

## Approval node config

| Property | Description |
|----------|-------------|
| `approval_type` | Type of approval (e.g., `human_review`) |
| `prompt_message` | Message shown to the human reviewer |
| `review_keys` | State keys the reviewer should examine |
| `timeout_ms` | How long to wait before the approval times out |

## Resuming a paused workflow

When the workflow reaches an approval node, it persists state with `status: 'waiting'` and emits a `workflow:waiting` event. To resume:

1. The human reviews the output
2. Your application calls resume on the workflow with the decision (approved/rejected)
3. The `GraphRunner` loads the persisted state and continues from the approval node

## Use cases

- **Content review** — writer produces a draft, editor approves before publishing
- **High-stakes actions** — agent proposes a deployment, human signs off
- **Compliance** — automated analysis with mandatory human review
- **Iterative feedback** — human provides feedback, agent revises

## Next steps

- [Human-in-the-loop example](https://gitlab.com/wmcmahan/mc-ai/tree/main/packages/orchestrator/examples/human-in-the-loop) — complete runnable example
- [Workflow State](/concepts/workflow-state/) — how paused state is persisted and resumed
- [Supervisor](/patterns/supervisor/) — combine HITL with dynamic routing
