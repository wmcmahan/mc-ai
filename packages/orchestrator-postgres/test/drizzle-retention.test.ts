/**
 * DrizzleRetentionService Tests
 *
 * Integration tests for the retention lifecycle.
 * Validates Week 1 fix 1.3 (transactional archiving).
 */

import { describe, test, expect } from 'vitest';
import { setupDatabaseTests, isDatabaseAvailable } from './setup.js';
import { DrizzleRetentionService } from '../src/drizzle-retention.js';
import { DrizzlePersistenceProvider } from '../src/drizzle-persistence.js';
import { createWorkflowState, createGraph } from '@mcai/orchestrator';
import { getDb } from './setup.js';
import { workflow_runs } from '../src/schema.js';
import { eq } from 'drizzle-orm';

describe.skipIf(!isDatabaseAvailable())('DrizzleRetentionService', () => {
  setupDatabaseTests();

  const retention = new DrizzleRetentionService();
  const persistence = new DrizzlePersistenceProvider();

  async function createCompletedWorkflow(completedAt: Date) {
    const graph = createGraph({
      name: 'Test',
      description: 'Test',
      nodes: [{
        id: 'start',
        type: 'agent',
        agent_id: 'a1',
        read_keys: ['*'],
        write_keys: ['*'],
      }],
      edges: [],
      start_node: 'start',
      end_nodes: ['start'],
    });
    await persistence.saveGraph(graph);

    const state = createWorkflowState({
      workflow_id: graph.id,
      goal: 'Test',
      status: 'completed',
    });

    await persistence.saveWorkflowRun(state);
    await persistence.saveWorkflowState(state);

    // Backdate the completed_at to make it eligible for archiving
    const db = await getDb();
    await db.update(workflow_runs)
      .set({ completed_at: completedAt })
      .where(eq(workflow_runs.id, state.run_id));

    return state;
  }

  describe('archiveCompletedWorkflows', () => {
    test('should archive workflows completed more than 24h ago', async () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await createCompletedWorkflow(twoDaysAgo);

      const archived = await retention.archiveCompletedWorkflows();
      expect(archived).toBeGreaterThanOrEqual(1);
    });

    test('should not archive recent workflows', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await createCompletedWorkflow(oneHourAgo);

      const archived = await retention.archiveCompletedWorkflows();
      expect(archived).toBe(0);
    });

    test('should return 0 when no workflows to archive', async () => {
      const archived = await retention.archiveCompletedWorkflows();
      expect(archived).toBe(0);
    });
  });

  describe('getStorageStats', () => {
    test('should return stats with zero counts when empty', async () => {
      const stats = await retention.getStorageStats();
      expect(stats.hot_runs).toBe(0);
      expect(stats.warm_runs).toBe(0);
      expect(stats.cold_runs).toBe(0);
    });
  });
});
