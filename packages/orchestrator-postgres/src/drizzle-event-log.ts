/**
 * Drizzle Event Log Writer
 *
 * Production event log writer backed by PostgreSQL.
 * Implements EventLogWriter from @mcai/orchestrator.
 */

import { db } from './connection.js';
import { workflow_events, workflow_checkpoints } from './schema.js';
import type { WorkflowStateJson } from './schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { EventLogWriter } from '@mcai/orchestrator';
import type { NewWorkflowEvent, WorkflowEvent, Action, WorkflowState } from '@mcai/orchestrator';

/**
 * Production event log writer backed by the `workflow_events` PostgreSQL table.
 */
export class DrizzleEventLogWriter implements EventLogWriter {
  async append(event: NewWorkflowEvent): Promise<void> {
    try {
      await db.insert(workflow_events).values({
        run_id: event.run_id,
        sequence_id: event.sequence_id,
        event_type: event.event_type as 'workflow_started' | 'node_started' | 'action_dispatched' | 'internal_dispatched' | 'state_persisted',
        node_id: event.node_id ?? null,
        action: event.action ? toSerializable(event.action) : null,
        internal_type: event.internal_type ?? null,
        internal_payload: event.internal_payload ?? null,
        created_at: new Date(),
      });
    } catch (error) {
      // Log but don't throw — event log failures should not halt the workflow.
      console.error('[drizzle-event-log] event_append_failed', {
        run_id: event.run_id,
        sequence_id: event.sequence_id,
        event_type: event.event_type,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  async loadEvents(run_id: string): Promise<WorkflowEvent[]> {
    const rows = await db
      .select()
      .from(workflow_events)
      .where(eq(workflow_events.run_id, run_id))
      .orderBy(workflow_events.sequence_id);
    return rows.map(fromRow);
  }

  async loadEventsAfter(run_id: string, afterSequenceId: number): Promise<WorkflowEvent[]> {
    const rows = await db
      .select()
      .from(workflow_events)
      .where(
        and(
          eq(workflow_events.run_id, run_id),
          sql`${workflow_events.sequence_id} > ${afterSequenceId}`
        )
      )
      .orderBy(workflow_events.sequence_id);
    return rows.map(fromRow);
  }

  async getLatestSequenceId(run_id: string): Promise<number> {
    const result = await db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${workflow_events.sequence_id}), -1)` })
      .from(workflow_events)
      .where(eq(workflow_events.run_id, run_id));

    return result[0]?.maxSeq ?? -1;
  }

  async checkpoint(run_id: string, sequenceId: number, state: WorkflowState): Promise<void> {
    await db.insert(workflow_checkpoints).values({
      run_id,
      sequence_id: sequenceId,
      state: toSerializable(state) as WorkflowStateJson,
      created_at: new Date(),
    });
  }

  async loadCheckpoint(run_id: string): Promise<{ sequence_id: number; state: WorkflowState } | null> {
    const result = await db
      .select()
      .from(workflow_checkpoints)
      .where(eq(workflow_checkpoints.run_id, run_id))
      .orderBy(desc(workflow_checkpoints.sequence_id))
      .limit(1);

    const row = result[0] ?? null;
    if (!row) return null;
    return {
      sequence_id: row.sequence_id,
      state: row.state as unknown as WorkflowState,
    };
  }

  async compact(run_id: string, beforeSequenceId: number): Promise<number> {
    return db.transaction(async (tx) => {
      const result = await tx
        .delete(workflow_events)
        .where(
          and(
            eq(workflow_events.run_id, run_id),
            sql`${workflow_events.sequence_id} <= ${beforeSequenceId}`
          )
        )
        .returning({ id: workflow_events.id });

      return result.length;
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fromRow(row: typeof workflow_events.$inferSelect): WorkflowEvent {
  return {
    id: row.id,
    run_id: row.run_id,
    sequence_id: row.sequence_id,
    event_type: row.event_type as WorkflowEvent['event_type'],
    node_id: row.node_id ?? undefined,
    action: row.action ? (row.action as unknown as Action) : undefined,
    internal_type: row.internal_type ?? undefined,
    internal_payload: row.internal_payload
      ? (row.internal_payload as Record<string, unknown>)
      : undefined,
    created_at: row.created_at,
  };
}

function toSerializable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
