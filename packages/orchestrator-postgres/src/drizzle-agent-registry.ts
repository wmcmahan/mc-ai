/**
 * Drizzle Agent Registry
 *
 * Implements AgentRegistry by querying the `agents` table.
 */

import { db } from './connection.js';
import { agents } from './schema.js';
import { eq } from 'drizzle-orm';
import type { AgentRegistry, AgentRegistryEntry } from '@mcai/orchestrator';

export class DrizzleAgentRegistry implements AgentRegistry {
  async loadAgent(id: string): Promise<AgentRegistryEntry | null> {
    const result = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);

    if (result.length === 0) return null;

    const row = result[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      model: row.model,
      provider: row.provider,
      system_prompt: row.system_prompt,
      temperature: row.temperature,
      max_steps: row.max_steps,
      tools: row.tools,
      permissions: row.permissions,
    };
  }
}
