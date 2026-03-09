/**
 * Drizzle Usage Recorder
 *
 * Implements UsageRecorder using Drizzle ORM + PostgreSQL.
 */

import { db } from './connection.js';
import { usage_records } from './schema.js';
import type { UsageRecorder, UsageRecord } from '@mcai/orchestrator';

export class DrizzleUsageRecorder implements UsageRecorder {
  async saveUsageRecord(record: UsageRecord): Promise<void> {
    await db.insert(usage_records).values({
      run_id: record.run_id,
      api_key_id: record.api_key_id ?? null,
      graph_id: record.graph_id,
      input_tokens: record.input_tokens,
      output_tokens: record.output_tokens,
      cost_usd: String(record.cost_usd),
      duration_ms: record.duration_ms,
    }).onConflictDoNothing();
  }
}
