/**
 * @mcai/orchestrator-postgres
 *
 * Official PostgreSQL adapter for @mcai/orchestrator.
 * Provides Drizzle ORM implementations of all persistence interfaces.
 *
 * @example
 * ```ts
 * import { getDb, closeDb, DrizzlePersistenceProvider, DrizzleAgentRegistry } from '@mcai/orchestrator-postgres';
 * import { configureAgentFactory, GraphRunner } from '@mcai/orchestrator';
 *
 * await getDb();
 * configureAgentFactory(new DrizzleAgentRegistry());
 * const persistence = new DrizzlePersistenceProvider();
 * ```
 */

// Connection management
export { db, getDb, getPool, closeDb, getPoolMetrics } from './connection.js';
export type { PoolMetrics } from './connection.js';

// Schema + types
export * from './schema.js';

// Persistence adapters
export { DrizzlePersistenceProvider, toWorkflowStateJson } from './drizzle-persistence.js';
export { DrizzleEventLogWriter } from './drizzle-event-log.js';
export { DrizzleUsageRecorder } from './drizzle-usage.js';
export { DrizzleRetentionService } from './drizzle-retention.js';
export { DrizzleAgentRegistry } from './drizzle-agent-registry.js';
