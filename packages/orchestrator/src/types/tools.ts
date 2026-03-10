/**
 * Tool Source Types — MCP Server Registry & Agent Tool Declarations
 *
 * Defines the structured tool source system that replaces bare `string[]`
 * tool references in agent configs. Agents declare what tools they need
 * via `ToolSource[]`; the trusted MCP Server Registry holds transport
 * configurations.
 *
 * @module types/tools
 */

import { z } from 'zod';

// ─── Tool Source (Agent Config Level) ──────────────────────────────

/**
 * Known built-in tool names.
 * These are handled directly by the orchestrator without MCP.
 */
export const BUILTIN_TOOL_NAMES = [
  'save_to_memory',
  'architect_draft_workflow',
  'architect_publish_workflow',
  'architect_get_workflow',
] as const;

/**
 * A built-in tool provided by the orchestrator itself (not via MCP).
 */
export const BuiltinToolSourceSchema = z.object({
  type: z.literal('builtin'),
  name: z.enum(BUILTIN_TOOL_NAMES),
});

/**
 * A tool provided by a registered MCP server.
 *
 * References a server by ID (never contains transport config).
 * Optionally filters to specific tool names from that server.
 */
export const MCPToolSourceSchema = z.object({
  type: z.literal('mcp'),
  server_id: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'server_id must be alphanumeric, hyphens, or underscores'),
  /** Filter to specific tools from this server. Omit for all tools. */
  tool_names: z.array(z.string()).optional(),
});

/**
 * Discriminated union of tool source types.
 *
 * Agents declare their tool requirements as `ToolSource[]`.
 * Resolution happens at execution time via MCPConnectionManager.
 */
export const ToolSourceSchema = z.discriminatedUnion('type', [
  BuiltinToolSourceSchema,
  MCPToolSourceSchema,
]);

export type ToolSource = z.infer<typeof ToolSourceSchema>;
export type BuiltinToolSource = z.infer<typeof BuiltinToolSourceSchema>;
export type MCPToolSource = z.infer<typeof MCPToolSourceSchema>;

// ─── MCP Transport Configs (Registry Level) ────────────────────────

/** Allowed commands for stdio transports (security: no arbitrary execution). */
const ALLOWED_STDIO_COMMANDS = ['npx', 'node', 'python3', 'python', 'uvx'] as const;

export const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.enum(ALLOWED_STDIO_COMMANDS),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export const HTTPTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const SSETransportSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const MCPTransportConfigSchema = z.discriminatedUnion('type', [
  StdioTransportSchema,
  HTTPTransportSchema,
  SSETransportSchema,
]);

export type MCPTransportConfig = z.infer<typeof MCPTransportConfigSchema>;

// ─── MCP Server Entry (Registry Data) ──────────────────────────────

/**
 * A registered MCP server entry.
 *
 * Stored in the trusted MCP Server Registry. Only administrators
 * can create/modify entries. Agent configs reference servers by `id`.
 */
export const MCPServerEntrySchema = z.object({
  /** Unique server identifier (used as map key and in tool namespacing). */
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i),
  /** Human-readable name. */
  name: z.string(),
  /** Optional description of what this server provides. */
  description: z.string().optional(),
  /** Transport configuration (stdio, HTTP, or SSE). */
  transport: MCPTransportConfigSchema,
  /** Agent IDs allowed to use this server. Omit or `undefined` for unrestricted access. */
  allowed_agents: z.array(z.string()).optional(),
  /** Connection timeout in milliseconds. */
  timeout_ms: z.number().default(30_000),
});

export type MCPServerEntry = z.infer<typeof MCPServerEntrySchema>;
