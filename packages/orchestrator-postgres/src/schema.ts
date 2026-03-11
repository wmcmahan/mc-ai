/**
 * Database Schema — Engine Tables
 *
 * Drizzle ORM table definitions for the orchestration engine.
 * Platform-specific tables (e.g. api_keys) live in the consuming application.
 *
 * @module @mcai/orchestrator-postgres/schema
 */

import { sql } from 'drizzle-orm';
import type { ToolSource, MCPTransportConfig } from '@mcai/orchestrator';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  vector,
  real,
  integer,
  numeric,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ─── Shared Constants ───────────────────────────────────────────────────

const WORKFLOW_STATUSES = [
  'pending',
  'scheduled',
  'running',
  'waiting',
  'retrying',
  'completed',
  'failed',
  'cancelled',
  'timeout',
] as const;

// ─── JSONB Column Types ─────────────────────────────────────────────────

export interface GraphDefinitionJson {
  id: string;
  name: string;
  nodes: unknown[];
  edges: unknown[];
  start_node: string;
  end_nodes: string[];
  [key: string]: unknown;
}

export interface WorkflowStateJson {
  workflow_id: string;
  run_id: string;
  status: string;
  current_node?: string;
  memory: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelBreakdown {
  [model: string]: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
}

// ─── Tables ─────────────────────────────────────────────────────────────

export const graphs = pgTable('graphs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  definition: jsonb('definition').$type<GraphDefinitionJson>().notNull(),
  version: text('version').default('1.0.0'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  graph_id: uuid('graph_id').references(() => graphs.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const workflow_runs = pgTable('workflow_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflow_id: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
  graph_id: uuid('graph_id').references(() => graphs.id, { onDelete: 'restrict' }).notNull(),
  status: text('status', { enum: WORKFLOW_STATUSES }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  parent_run_id: uuid('parent_run_id').references((): AnyPgColumn => workflow_runs.id, { onDelete: 'set null' }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  archived_at: timestamp('archived_at', { withTimezone: true }),
}, (table) => [
  index('idx_workflow_runs_status').on(table.status),
  index('idx_workflow_runs_graph_id').on(table.graph_id),
  index('idx_workflow_runs_created_at_desc').on(table.created_at),
  index('idx_workflow_runs_completed_not_archived').on(table.completed_at).where(sql`archived_at IS NULL`),
]);

export const workflow_states = pgTable('workflow_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  run_id: uuid('run_id').references(() => workflow_runs.id, { onDelete: 'cascade' }).notNull(),
  version: integer('version').notNull().default(1),
  state: jsonb('state').$type<WorkflowStateJson>().notNull(),
  current_node: text('current_node'),
  status: text('status', { enum: WORKFLOW_STATUSES }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  archived_at: timestamp('archived_at', { withTimezone: true }),
}, (table) => [
  index('idx_workflow_states_run_created').on(table.run_id, table.created_at),
  uniqueIndex('uq_workflow_states_run_version').on(table.run_id, table.version),
  index('idx_workflow_states_status').on(table.status),
  index('idx_workflow_states_archived_at').on(table.archived_at).where(sql`archived_at IS NOT NULL`),
]);

export const workflow_events = pgTable('workflow_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  run_id: uuid('run_id').references(() => workflow_runs.id, { onDelete: 'cascade' }).notNull(),
  sequence_id: integer('sequence_id').notNull(),
  event_type: text('event_type', {
    enum: ['workflow_started', 'node_started', 'action_dispatched', 'internal_dispatched', 'state_persisted'],
  }).notNull(),
  node_id: text('node_id'),
  action: jsonb('action'),
  internal_type: text('internal_type'),
  internal_payload: jsonb('internal_payload'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('uq_workflow_events_run_seq').on(table.run_id, table.sequence_id),
  index('idx_workflow_events_run_type').on(table.run_id, table.event_type),
]);

export const workflow_checkpoints = pgTable('workflow_checkpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  run_id: uuid('run_id').references(() => workflow_runs.id, { onDelete: 'cascade' }).notNull(),
  sequence_id: integer('sequence_id').notNull(),
  state: jsonb('state').$type<WorkflowStateJson>().notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_workflow_checkpoints_run_seq').on(table.run_id, table.sequence_id),
]);

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description'),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  system_prompt: text('system_prompt').notNull(),
  temperature: real('temperature').notNull().default(0.7),
  max_steps: integer('max_steps').notNull().default(10),
  tools: jsonb('tools').notNull().$type<ToolSource[]>(),
  permissions: jsonb('permissions').notNull().$type<{
    sandbox: boolean;
    read_keys: string[];
    write_keys: string[];
    budget_usd?: number;
  }>(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const mcp_servers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  transport: jsonb('transport').$type<MCPTransportConfig>().notNull(),
  allowed_agents: jsonb('allowed_agents').$type<string[]>(),
  timeout_ms: integer('timeout_ms').notNull().default(30000),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull(),
  title: text('title').notNull(),
  url: text('url'),
  file_path: text('file_path'),
  mime_type: text('mime_type'),
  content: text('content').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const embeddings = pgTable('embeddings', {
  id: uuid('id').primaryKey().defaultRandom(),
  document_id: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }).notNull(),
  chunk_index: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_embeddings_vector').using('hnsw', table.embedding.op('vector_cosine_ops')),
]);

export const usage_records = pgTable('usage_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  run_id: uuid('run_id').references(() => workflow_runs.id, { onDelete: 'cascade' }),
  api_key_id: uuid('api_key_id'),
  graph_id: uuid('graph_id').references(() => graphs.id, { onDelete: 'set null' }),
  input_tokens: integer('input_tokens').notNull().default(0),
  output_tokens: integer('output_tokens').notNull().default(0),
  cost_usd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  model_breakdown: jsonb('model_breakdown').$type<ModelBreakdown>(),
  duration_ms: integer('duration_ms'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_usage_records_run_id').on(table.run_id),
  index('idx_usage_records_api_key_id').on(table.api_key_id),
  index('idx_usage_records_created_at').on(table.created_at),
]);

// ─── Inferred Types ─────────────────────────────────────────────────────

export type Graph = typeof graphs.$inferSelect;
export type NewGraph = typeof graphs.$inferInsert;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowRun = typeof workflow_runs.$inferSelect;
export type NewWorkflowRun = typeof workflow_runs.$inferInsert;
export type WorkflowState = typeof workflow_states.$inferSelect;
export type NewWorkflowState = typeof workflow_states.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type Embedding = typeof embeddings.$inferSelect;
export type WorkflowEventRow = typeof workflow_events.$inferSelect;
export type NewWorkflowEventRow = typeof workflow_events.$inferInsert;
export type WorkflowCheckpointRow = typeof workflow_checkpoints.$inferSelect;
export type NewWorkflowCheckpointRow = typeof workflow_checkpoints.$inferInsert;
export type UsageRecord = typeof usage_records.$inferSelect;
export type NewUsageRecord = typeof usage_records.$inferInsert;
export type MCPServer = typeof mcp_servers.$inferSelect;
export type NewMCPServer = typeof mcp_servers.$inferInsert;
