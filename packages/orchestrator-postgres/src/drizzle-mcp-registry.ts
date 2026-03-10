/**
 * Drizzle MCP Server Registry
 *
 * Implements MCPServerRegistry by querying the `mcp_servers` table.
 */

import { db } from './connection.js';
import { mcp_servers } from './schema.js';
import { eq } from 'drizzle-orm';
import type { MCPServerRegistry } from '@mcai/orchestrator';
import type { MCPServerEntry } from '@mcai/orchestrator';

export class DrizzleMCPServerRegistry implements MCPServerRegistry {
  async saveServer(entry: MCPServerEntry): Promise<void> {
    await db
      .insert(mcp_servers)
      .values({
        id: entry.id,
        name: entry.name,
        description: entry.description ?? null,
        transport: entry.transport,
        allowed_agents: entry.allowed_agents ?? null,
        timeout_ms: entry.timeout_ms,
      })
      .onConflictDoUpdate({
        target: mcp_servers.id,
        set: {
          name: entry.name,
          description: entry.description ?? null,
          transport: entry.transport,
          allowed_agents: entry.allowed_agents ?? null,
          timeout_ms: entry.timeout_ms,
          updated_at: new Date(),
        },
      });
  }

  async loadServer(id: string): Promise<MCPServerEntry | null> {
    const result = await db
      .select()
      .from(mcp_servers)
      .where(eq(mcp_servers.id, id))
      .limit(1);

    if (result.length === 0) return null;

    const row = result[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      transport: row.transport,
      allowed_agents: row.allowed_agents ?? undefined,
      timeout_ms: row.timeout_ms,
    };
  }

  async listServers(): Promise<MCPServerEntry[]> {
    const rows = await db.select().from(mcp_servers);
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      transport: row.transport,
      allowed_agents: row.allowed_agents ?? undefined,
      timeout_ms: row.timeout_ms,
    }));
  }

  async deleteServer(id: string): Promise<boolean> {
    const result = await db.delete(mcp_servers).where(eq(mcp_servers.id, id));
    return (result.rowCount ?? 0) > 0;
  }
}
