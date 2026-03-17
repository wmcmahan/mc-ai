/**
 * DrizzleEventLogWriter Tests
 *
 * Integration tests for event sourcing against Postgres.
 * Validates Week 1 fix 1.2 (error propagation).
 */

import { describe, test, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
import { DrizzleEventLogWriter } from '../src/drizzle-event-log.js';
import { createWorkflowState } from '@mcai/orchestrator';
import type { WorkflowState } from '@mcai/orchestrator';

describe.skipIf(!isDatabaseAvailable())('DrizzleEventLogWriter', () => {
  setupDatabaseTests();

  const writer = new DrizzleEventLogWriter();
  const runId = crypto.randomUUID();

  function makeState(): WorkflowState {
    return createWorkflowState({
      workflow_id: crypto.randomUUID(),
      goal: 'Test',
    });
  }

  describe('append / loadEvents', () => {
    test('should append and load events in order', async () => {
      await writer.append({
        run_id: runId,
        sequence_id: 0,
        event_type: 'workflow_started',
      });
      await writer.append({
        run_id: runId,
        sequence_id: 1,
        event_type: 'node_started',
        node_id: 'start',
      });

      const events = await writer.loadEvents(runId);
      expect(events).toHaveLength(2);
      expect(events[0].event_type).toBe('workflow_started');
      expect(events[0].sequence_id).toBe(0);
      expect(events[1].event_type).toBe('node_started');
      expect(events[1].node_id).toBe('start');
    });
  });

  describe('loadEventsAfter', () => {
    test('should load only events after the given sequence ID', async () => {
      const rid = crypto.randomUUID();
      for (let i = 0; i < 5; i++) {
        await writer.append({
          run_id: rid,
          sequence_id: i,
          event_type: i === 0 ? 'workflow_started' : 'node_started',
          node_id: i > 0 ? `node-${i}` : undefined,
        });
      }

      const after = await writer.loadEventsAfter(rid, 2);
      expect(after).toHaveLength(2); // seq 3 and 4
      expect(after[0].sequence_id).toBe(3);
    });
  });

  describe('getLatestSequenceId', () => {
    test('should return -1 for empty run', async () => {
      const latest = await writer.getLatestSequenceId(crypto.randomUUID());
      expect(latest).toBe(-1);
    });

    test('should return highest sequence ID', async () => {
      const rid = crypto.randomUUID();
      await writer.append({ run_id: rid, sequence_id: 0, event_type: 'workflow_started' });
      await writer.append({ run_id: rid, sequence_id: 1, event_type: 'node_started' });

      const latest = await writer.getLatestSequenceId(rid);
      expect(latest).toBe(1);
    });
  });

  describe('checkpoint / loadCheckpoint', () => {
    test('should save and load checkpoint', async () => {
      const rid = crypto.randomUUID();
      const state = makeState();

      await writer.checkpoint(rid, 5, state);
      const cp = await writer.loadCheckpoint(rid);

      expect(cp).not.toBeNull();
      expect(cp!.sequence_id).toBe(5);
      expect(cp!.state.goal).toBe('Test');
    });

    test('should return null for non-existent checkpoint', async () => {
      const cp = await writer.loadCheckpoint(crypto.randomUUID());
      expect(cp).toBeNull();
    });

    test('should return latest checkpoint when multiple exist', async () => {
      const rid = crypto.randomUUID();
      const state = makeState();

      await writer.checkpoint(rid, 3, state);
      await writer.checkpoint(rid, 7, state);

      const cp = await writer.loadCheckpoint(rid);
      expect(cp!.sequence_id).toBe(7);
    });
  });

  describe('compact', () => {
    test('should delete events before the given sequence ID', async () => {
      const rid = crypto.randomUUID();
      for (let i = 0; i < 5; i++) {
        await writer.append({
          run_id: rid,
          sequence_id: i,
          event_type: i === 0 ? 'workflow_started' : 'node_started',
        });
      }

      const deleted = await writer.compact(rid, 2);
      expect(deleted).toBe(3); // seq 0, 1, 2

      const remaining = await writer.loadEvents(rid);
      expect(remaining).toHaveLength(2); // seq 3, 4
    });
  });

  /**
   * Validates fix 1.2: errors propagate instead of being swallowed.
   * We can't easily mock the DB layer in an integration test, but
   * we verify the method signature allows error propagation by checking
   * that a constraint violation actually throws.
   */
  describe('error propagation (fix 1.2)', () => {
    test('should propagate duplicate sequence_id error', async () => {
      const rid = crypto.randomUUID();
      await writer.append({ run_id: rid, sequence_id: 0, event_type: 'workflow_started' });

      // Duplicate sequence_id should throw (unique constraint or similar)
      await expect(
        writer.append({ run_id: rid, sequence_id: 0, event_type: 'workflow_started' }),
      ).rejects.toThrow();
    });
  });
});
