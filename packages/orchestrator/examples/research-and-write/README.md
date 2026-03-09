# Research & Write

A 2-node linear workflow where a Researcher agent gathers notes on a topic and a Writer agent produces a polished summary. Demonstrates agent-as-config, zero-trust state slicing, graph definition, in-memory persistence, and event listeners.

## Graph

```mermaid
flowchart LR
    research["🔬 research\n(agent)"]
    write["✍️ write\n(agent)"]

    research -- always --> write
```

## Lifecycle & State

```mermaid
sequenceDiagram
    participant U as Caller
    participant R as GraphRunner
    participant RN as research (agent)
    participant WN as write (agent)
    participant S as WorkflowState

    U->>R: runner.run()
    R->>S: status = running
    Note over S: memory: {}

    R->>RN: execute (reads: goal, constraints)
    RN->>RN: LLM call → research notes
    RN->>S: reducer: set memory.research_notes
    Note over S: memory: { research_notes: "..." }

    R->>R: persist state, follow edge

    R->>WN: execute (reads: goal, research_notes)
    WN->>WN: LLM call → polished draft
    WN->>S: reducer: set memory.draft
    Note over S: memory: { research_notes: "...", draft: "..." }

    R->>S: status = completed
    R->>U: return finalState
```

## State Slicing

Each node only sees the keys it declares — the engine enforces zero-trust boundaries:

```mermaid
block-beta
    columns 3

    block:state["WorkflowState (blackboard)"]:3
        goal constraints research_notes draft
    end

    space:3

    block:rn["research node"]
        r_read["reads: goal, constraints"]
        r_write["writes: research_notes"]
    end

    space

    block:wn["write node"]
        w_read["reads: goal, research_notes"]
        w_write["writes: draft"]
    end
```

## Run

```bash
cd packages/orchestrator
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/research-and-write/research-and-write.ts
```

## Expected Output

```
[INFO] Starting research-and-write workflow...
[INFO] Workflow started: <run-id>
[INFO]   Node started: research (agent)
[INFO]   Node complete: research (2340ms)
[INFO]   Node started: write (agent)
[INFO]   Node complete: write (1820ms)
[INFO] Workflow complete: <run-id> (4160ms)

═══ Research Notes ═══
• Transformers use self-attention to process sequences in parallel ...

═══ Final Draft ═══
Large language models are AI systems trained on vast amounts of text ...

═══ Stats ═══
  Tokens used: 1523
  Cost (USD):  $0.0091
```
