/**
 * MCP Connection Manager
 *
 * Manages lifecycle of `@ai-sdk/mcp` client connections per workflow run.
 * Resolves agent ToolSource declarations into AI SDK tool sets by looking up server
 * configs from the trusted MCPServerRegistry.
 *
 * Key design decisions:
 * - Lazy connection: clients are created on first use, not at startup
 * - Connection dedup: concurrent resolveTools() calls for the same server
 *   share a single pending connection promise (stampede prevention)
 * - Immutable taint wrapping: tool execute functions are wrapped without
 *   mutating the shared tool objects from `@ai-sdk/mcp`
 * - Collision-only namespacing: tools are namespaced with `serverId__` prefix
 *   only when actual name collisions are detected across servers
 *
 * @module mcp/connection-manager
 */

import { createLogger } from '../utils/logger.js';
import { MCPServerNotFoundError, MCPAccessDeniedError } from './errors.js';
import type { MCPServerRegistry } from '../persistence/interfaces.js';
import type { ToolSource, MCPServerEntry } from '../types/tools.js';
import type { TaintMetadata } from '../types/state.js';

const logger = createLogger('mcp.connections');

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Taint-wrapped tool result returned by MCP tool execution.
 */
export interface TaintedToolResult {
  readonly result: unknown;
  readonly taint: TaintMetadata;
}

/**
 * Abstract interface for tool resolution (DI seam for testing).
 */
export interface ToolResolver {
  /**
   * Resolve an array of ToolSource declarations into an AI SDK tool set.
   * Returns a merged record of tool name → tool object with execute functions.
   *
   * @param sources - Tool source declarations from the agent config.
   * @param agentId - The requesting agent's ID (for access control).
   */
  resolveTools(sources: ToolSource[], agentId?: string): Promise<Record<string, unknown>>;

  /**
   * Close all open MCP client connections and release resources.
   */
  closeAll(): Promise<void>;

  /**
   * Drain accumulated taint entries from MCP tool executions.
   * Returns the accumulated entries (keyed by `serverId:toolName`) and clears the internal map.
   * Optional — only implemented by MCPConnectionManager.
   */
  drainTaintEntries?(): Map<string, TaintMetadata>;
}

// ─── Lazy Imports ───────────────────────────────────────────────────

// @ai-sdk/mcp is an optional peer dependency. We import lazily to avoid
// hard failures when it's not installed (e.g., in unit tests that only
// use built-in tools).

type MCPClientType = {
  tools(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

type CreateMCPClientFn = (config: {
  transport: unknown;
  name?: string;
  onUncaughtError?: (error: unknown) => void;
}) => Promise<MCPClientType>;

let _createMCPClient: CreateMCPClientFn | null = null;
let _StdioTransport: (new (config: { command: string; args?: string[]; env?: Record<string, string> }) => unknown) | null = null;

async function getCreateMCPClient(): Promise<CreateMCPClientFn> {
  if (!_createMCPClient) {
    const mod = await import('@ai-sdk/mcp');
    _createMCPClient = mod.createMCPClient as CreateMCPClientFn;
  }
  return _createMCPClient;
}

async function getStdioTransport(): Promise<typeof _StdioTransport> {
  if (!_StdioTransport) {
    const mod = await import('@ai-sdk/mcp/mcp-stdio');
    _StdioTransport = (mod as Record<string, unknown>).Experimental_StdioMCPTransport as typeof _StdioTransport;
  }
  return _StdioTransport;
}

// ─── Built-in Tools ─────────────────────────────────────────────────

/**
 * Registry of built-in tool factories.
 *
 * Returns raw tool definitions (description + parameters + execute).
 * These are NOT pre-formed AI SDK tools — they use the `parameters` key
 * with plain JSON schema objects. The executor's `buildToolSet()` wraps
 * them with `tool()` + `jsonSchema()` for AI SDK compatibility.
 *
 * IMPORTANT: Do NOT use `inputSchema` or `jsonSchema()` here. That would
 * cause `isAISDKTool()` to falsely classify them as pre-formed tools and
 * skip the `tool()` wrapping, breaking LLM tool presentation.
 */
function createBuiltinTool(name: string): Record<string, unknown> | null {
  switch (name) {
    case 'save_to_memory':
      // The actual persistence is handled by the reducer, not the tool.
      // The tool just captures the key/value pair from the LLM.
      return {
        save_to_memory: {
          description: 'Save data to workflow memory for later use',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Memory key to store the value under' },
              value: { description: 'Value to save (can be any type)' },
            },
            required: ['key', 'value'],
          },
          execute: async (args: Record<string, unknown>) => {
            return { key: args.key, value: args.value, saved: true };
          },
        },
      };
    // Architect tools are handled separately by the agent executor
    // since they need special dependencies (persistence, etc.)
    case 'architect_draft_workflow':
    case 'architect_publish_workflow':
    case 'architect_get_workflow':
      return null; // Handled by architect tool system
    default:
      return null;
  }
}

// ─── MCPConnectionManager ───────────────────────────────────────────

/**
 * Manages MCP client connections for a workflow run.
 *
 * Create one per GraphRunner.run() invocation. Call closeAll() when done.
 */
export class MCPConnectionManager implements ToolResolver {
  private readonly clients = new Map<string, MCPClientType>();
  private readonly pending = new Map<string, Promise<MCPClientType>>();
  private readonly registry: MCPServerRegistry;
  private taintEntries = new Map<string, TaintMetadata>();

  constructor(registry: MCPServerRegistry) {
    this.registry = registry;
  }

  /**
   * Resolve tool sources into a merged AI SDK tool set.
   *
   * Built-in tools are resolved synchronously.
   * MCP tools are resolved by connecting to the registered server.
   */
  async resolveTools(sources: ToolSource[], agentId?: string): Promise<Record<string, unknown>> {
    const tools: Record<string, unknown> = {};
    const mcpToolSets: Array<{ serverId: string; toolSet: Record<string, unknown>; filter?: string[] }> = [];

    // Separate built-in and MCP sources
    const mcpSources = sources.filter(s => s.type === 'mcp');
    const builtinSources = sources.filter(s => s.type === 'builtin');

    // Resolve built-ins synchronously
    for (const source of builtinSources) {
      const builtinTools = createBuiltinTool(source.name);
      if (builtinTools) {
        Object.assign(tools, builtinTools);
      }
    }

    // Resolve MCP tools in parallel (with access control)
    if (mcpSources.length > 0) {
      const results = await Promise.all(
        mcpSources.map(async (source) => {
          await this.checkAccess(source.server_id, agentId);
          const client = await this.getClient(source.server_id);
          const toolSet = await client.tools() as Record<string, unknown>;
          return { serverId: source.server_id, toolSet, filter: source.tool_names };
        })
      );

      for (const result of results) {
        mcpToolSets.push(result);
      }
    }

    // Merge MCP tools with collision detection
    const allToolNames = new Map<string, string[]>(); // toolName → [serverIds]

    for (const { serverId, toolSet, filter } of mcpToolSets) {
      const toolNames = filter ?? Object.keys(toolSet);
      for (const name of toolNames) {
        if (!(name in toolSet)) {
          logger.warn('filtered_tool_not_found', { server_id: serverId, tool_name: name });
          continue;
        }
        const existing = allToolNames.get(name) ?? [];
        existing.push(serverId);
        allToolNames.set(name, existing);
      }
    }

    // Detect collisions
    const collisions = new Set<string>();
    for (const [name, serverIds] of allToolNames) {
      if (serverIds.length > 1 || (name in tools)) {
        collisions.add(name);
      }
    }

    // Add MCP tools with taint wrapping and optional namespacing
    for (const { serverId, toolSet, filter } of mcpToolSets) {
      const toolNames = filter ?? Object.keys(toolSet);
      for (const name of toolNames) {
        if (!(name in toolSet)) continue;

        const tool = toolSet[name] as Record<string, unknown>;
        const wrappedTool = this.wrapToolWithTaint(tool, name, serverId);
        const finalName = collisions.has(name) ? `${serverId}__${name}` : name;

        if (collisions.has(name)) {
          logger.info('tool_namespaced', { tool_name: name, server_id: serverId, namespaced_as: finalName });
        }

        tools[finalName] = wrappedTool;
      }
    }

    return tools;
  }

  /**
   * Get or create an MCP client for a server ID.
   * Uses pending-promise dedup to prevent connection stampedes.
   */
  private async getClient(serverId: string): Promise<MCPClientType> {
    // Return existing connected client
    const existing = this.clients.get(serverId);
    if (existing) return existing;

    // Join pending connection if one exists
    const pending = this.pending.get(serverId);
    if (pending) return pending;

    // Start new connection
    const connectionPromise = this.connectToServer(serverId);
    this.pending.set(serverId, connectionPromise);

    try {
      const client = await connectionPromise;
      this.clients.set(serverId, client);
      return client;
    } finally {
      this.pending.delete(serverId);
    }
  }

  /**
   * Check if an agent is authorized to use an MCP server.
   * If `allowed_agents` is set on the server entry, the agent must be in the list.
   */
  private async checkAccess(serverId: string, agentId?: string): Promise<void> {
    const entry = await this.registry.loadServer(serverId);
    if (!entry) {
      throw new MCPServerNotFoundError(serverId);
    }

    if (entry.allowed_agents && entry.allowed_agents.length > 0) {
      if (!agentId || !entry.allowed_agents.includes(agentId)) {
        throw new MCPAccessDeniedError(agentId ?? 'unknown', serverId);
      }
    }
  }

  /**
   * Connect to an MCP server by looking up its config in the registry.
   */
  private async connectToServer(serverId: string): Promise<MCPClientType> {
    const entry = await this.registry.loadServer(serverId);
    if (!entry) {
      throw new MCPServerNotFoundError(serverId);
    }

    const transport = await this.buildTransport(entry);
    const createClient = await getCreateMCPClient();

    logger.info('connecting', { server_id: serverId, transport_type: entry.transport.type });

    const client = await createClient({
      transport,
      name: `mcai-${serverId}`,
      onUncaughtError: (error) => {
        logger.error('uncaught_mcp_error', error as Error, { server_id: serverId });
      },
    });

    logger.info('connected', { server_id: serverId });
    return client;
  }

  /**
   * Build an @ai-sdk/mcp transport config from our registry entry.
   */
  private async buildTransport(entry: MCPServerEntry): Promise<unknown> {
    const config = entry.transport;

    switch (config.type) {
      case 'stdio': {
        const StdioTransportClass = await getStdioTransport();
        if (!StdioTransportClass) {
          throw new Error('Stdio transport requires @ai-sdk/mcp/mcp-stdio — is @ai-sdk/mcp installed?');
        }
        return new StdioTransportClass({
          command: config.command,
          args: config.args,
          env: config.env,
        });
      }
      case 'http':
        return {
          type: 'http' as const,
          url: config.url,
          headers: config.headers,
        };
      case 'sse':
        return {
          type: 'sse' as const,
          url: config.url,
          headers: config.headers,
        };
    }
  }

  /**
   * Wrap a tool's execute function to accumulate taint metadata in the
   * internal map while returning the raw result to the AI SDK (and thus
   * to the LLM). This ensures the LLM never sees taint wrapper objects.
   * Creates a new tool object — never mutates the original.
   */
  private wrapToolWithTaint(
    tool: Record<string, unknown>,
    toolName: string,
    serverId: string,
  ): Record<string, unknown> {
    const originalExecute = tool.execute as ((args: unknown) => Promise<unknown>) | undefined;

    if (!originalExecute) {
      return { ...tool };
    }

    return {
      ...tool,
      execute: async (args: unknown): Promise<unknown> => {
        const result = await originalExecute(args);
        const taintKey = `${serverId}:${toolName}`;
        this.taintEntries.set(taintKey, {
          source: 'mcp_tool' as const,
          tool_name: toolName,
          server_id: serverId,
          created_at: new Date().toISOString(),
        });
        return result;
      },
    };
  }

  /**
   * Drain accumulated taint entries from MCP tool executions.
   * Returns the accumulated entries (keyed by `serverId:toolName`) and clears the internal map.
   * Call this after an agent execution completes to retrieve taint metadata for post-processing.
   */
  drainTaintEntries(): Map<string, TaintMetadata> {
    const entries = new Map(this.taintEntries);
    this.taintEntries.clear();
    return entries;
  }

  /**
   * Close all open MCP client connections.
   */
  async closeAll(): Promise<void> {
    const closePromises = [...this.clients.entries()].map(async ([serverId, client]) => {
      try {
        await client.close();
        logger.info('disconnected', { server_id: serverId });
      } catch (error) {
        logger.error('close_failed', error as Error, { server_id: serverId });
      }
    });

    await Promise.allSettled(closePromises);
    this.clients.clear();
    this.pending.clear();
  }
}
