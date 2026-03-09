/**
 * Tool Adapter
 *
 * Loads and executes tools for agent runtime, combining three sources
 * into a unified tool map:
 *
 * 1. **Built-in** — `save_to_memory` (always included)
 * 2. **Architect** — `architect_*` tools (from `architect/tools.ts`)
 * 3. **MCP** — external tools loaded from the MCP gateway
 *
 * Falls back gracefully if the MCP gateway is unavailable — only built-in
 * tools are returned, allowing agent execution to continue.
 *
 * All MCP tool results are automatically wrapped with
 * {@link TaintedToolResult} provenance metadata for downstream taint tracking.
 *
 * @module mcp/tool-adapter
 */

import { z } from 'zod';
import { mcpClient, type MCPGatewayClient, type MCPTool } from './gateway-client.js';
import { jsonSchemaToZod } from './json-schema-converter.js';
import { createLogger } from '../utils/logger.js';
import { architectToolDefinitions, executeArchitectTool } from '../architect/tools.js';
import type { TaintMetadata } from '../types/state.js';

const logger = createLogger('mcp.tools');

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Tool result wrapped with provenance metadata.
 *
 * All MCP tool results are automatically wrapped in this shape to enable
 * downstream taint tracking. The tool node executor checks for this shape
 * and propagates taint metadata to the `_taint_registry` in workflow memory.
 */
export interface TaintedToolResult {
  /** The actual tool execution result. */
  readonly result: unknown;
  /** Provenance metadata: source, tool name, agent ID, timestamp. */
  readonly taint: TaintMetadata;
}

/** Prefix for architect built-in tools. */
const ARCHITECT_TOOL_PREFIX = 'architect_';

/**
 * Tool definition used by the agent executor.
 *
 * The `parameters` field is a Zod schema that gets wrapped by the AI SDK's
 * `tool()` helper via `jsonSchema()` at execution time.
 */
export interface ToolDefinition {
  /** Human-readable description of what the tool does. */
  description: string;
  /** Zod schema for tool input parameters. */
  parameters: z.ZodType;
}

// ─── Tool Loading ───────────────────────────────────────────────────

/**
 * Load agent tools for execution.
 *
 * Combines built-in, architect, and MCP tools into a unified tool map.
 * Falls back gracefully if the MCP gateway is unavailable — only built-in
 * tools are returned.
 *
 * @param toolNames - Tool names from the agent's config (default: empty).
 * @param client - MCP gateway client instance (default: singleton).
 * @returns Map of tool name → {@link ToolDefinition}.
 */
export async function loadAgentTools(
  toolNames: string[] = [],
  client: MCPGatewayClient = mcpClient
): Promise<Record<string, ToolDefinition>> {
  const tools: Record<string, ToolDefinition> = {};

  // Built-in: save_to_memory (always included)
  tools.save_to_memory = {
    description: 'Save data to workflow memory for later use',
    parameters: z.object({
      key: z.string().describe('Memory key to store the value under'),
      value: z.unknown().describe('Value to save (can be any type)'),
    }),
  };

  // Built-in: architect tools (if requested)
  for (const toolName of toolNames) {
    if (toolName.startsWith(ARCHITECT_TOOL_PREFIX) && architectToolDefinitions[toolName]) {
      tools[toolName] = architectToolDefinitions[toolName];
      logger.info('builtin_tool_loaded', { tool_name: toolName });
    }
  }

  // Filter out built-in tools from MCP lookup
  const mcpToolNames = toolNames.filter(
    t => t !== 'save_to_memory' && !t.startsWith(ARCHITECT_TOOL_PREFIX)
  );

  if (mcpToolNames.length === 0) {
    return tools;
  }

  // Load MCP tools from gateway
  try {
    const mcpTools = await client.listTools();

    for (const toolName of mcpToolNames) {
      const mcpTool = mcpTools.find(t => t.name === toolName);

      if (!mcpTool) {
        logger.warn('tool_not_found', {
          tool_name: toolName,
          available: mcpTools.map(t => t.name),
        });
        continue;
      }

      try {
        tools[toolName] = {
          description: mcpTool.description,
          parameters: jsonSchemaToZod(mcpTool.inputSchema),
        };
        logger.info('tool_loaded', { tool_name: toolName });
      } catch (error) {
        logger.error('tool_schema_conversion_failed', error, { tool_name: toolName });
      }
    }
  } catch (error) {
    logger.error('gateway_unavailable', error);
    logger.info('fallback_to_builtin', { tools: ['save_to_memory'] });
  }

  return tools;
}

// ─── Tool Execution ─────────────────────────────────────────────────

/**
 * Execute a tool call with taint tracking.
 *
 * Routes to the appropriate handler based on tool name:
 * - `save_to_memory` → passthrough (actual persistence handled by reducer)
 * - `architect_*` → delegates to `executeArchitectTool()`
 * - Other → calls MCP gateway and wraps result with {@link TaintedToolResult}
 *
 * MCP tool execution errors are caught and returned as error objects
 * rather than thrown, allowing the agent to handle tool failures gracefully.
 *
 * @param toolName - Name of the tool to execute.
 * @param args - Tool input parameters.
 * @param agentId - Optional agent ID for taint tracking and audit logging.
 * @param client - MCP gateway client instance (default: singleton).
 * @returns Tool result (may be wrapped in {@link TaintedToolResult} for MCP tools).
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  agentId?: string,
  client: MCPGatewayClient = mcpClient
): Promise<unknown> {
  // Built-in: save_to_memory
  if (toolName === 'save_to_memory') {
    return { key: args.key, value: args.value, saved: true };
  }

  // Built-in: architect tools
  if (toolName.startsWith(ARCHITECT_TOOL_PREFIX)) {
    return executeArchitectTool(toolName, args);
  }

  // MCP tool execution — gateway client handles retries
  try {
    const result = await client.executeTool(toolName, args, agentId);
    logger.info('tool_executed', { tool_name: toolName, agent_id: agentId });

    return {
      result,
      taint: {
        source: 'mcp_tool' as const,
        tool_name: toolName,
        agent_id: agentId,
        created_at: new Date().toISOString(),
      },
    } satisfies TaintedToolResult;
  } catch (error) {
    logger.error('tool_execution_failed', error, { tool_name: toolName, agent_id: agentId });
    return {
      error: error instanceof Error ? error.message : 'Tool execution failed',
      tool_name: toolName,
    };
  }
}
