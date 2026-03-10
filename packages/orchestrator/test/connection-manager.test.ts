import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MCPConnectionManager } from '../src/mcp/connection-manager.js';
import { MCPServerNotFoundError, MCPAccessDeniedError } from '../src/mcp/errors.js';
import { InMemoryMCPServerRegistry } from '../src/persistence/in-memory.js';
import type { MCPServerEntry, ToolSource } from '../src/types/tools.js';

// ─── Mock @ai-sdk/mcp ──────────────────────────────────────────────

// We mock the lazy-imported @ai-sdk/mcp module to avoid needing
// real MCP server connections in tests.

const mockTools: Record<string, { description: string; execute: (args: unknown) => Promise<unknown> }> = {
  search: {
    description: 'Search the web',
    execute: async (args: unknown) => ({ results: ['result1'], query: args }),
  },
  fetch: {
    description: 'Fetch a URL',
    execute: async (args: unknown) => ({ content: 'fetched', url: args }),
  },
};

const mockTools2: Record<string, { description: string; execute: (args: unknown) => Promise<unknown> }> = {
  calculate: {
    description: 'Calculate math',
    execute: async (args: unknown) => ({ answer: 42, input: args }),
  },
  // Deliberately same name as server1 to test collision
  search: {
    description: 'Search documents',
    execute: async (args: unknown) => ({ docs: ['doc1'], query: args }),
  },
};

function createMockClient(tools: Record<string, unknown>) {
  return {
    tools: vi.fn().mockResolvedValue({ ...tools }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// Track created clients for assertions
let createdClients: Array<{ serverId: string; client: ReturnType<typeof createMockClient> }> = [];

vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(async (config: { name?: string }) => {
    // Determine which mock tools to use based on the client name
    const name = config.name ?? '';
    const tools = name.includes('server2') ? mockTools2 : mockTools;
    const client = createMockClient(tools);
    createdClients.push({ serverId: name.replace('mcai-', ''), client });
    return client;
  }),
}));

vi.mock('@ai-sdk/mcp/mcp-stdio', () => {
  class MockStdioTransport {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
  }
  return { Experimental_StdioMCPTransport: MockStdioTransport };
});

// ─── Fixtures ───────────────────────────────────────────────────────

const httpServer: MCPServerEntry = {
  id: 'server1',
  name: 'HTTP Server',
  transport: { type: 'http', url: 'https://mcp.example.com/api' },
  timeout_ms: 30_000,
};

const stdioServer: MCPServerEntry = {
  id: 'server2',
  name: 'Stdio Server',
  transport: { type: 'stdio', command: 'npx', args: ['-y', 'test-pkg'] },
  timeout_ms: 30_000,
};

const sseServer: MCPServerEntry = {
  id: 'server3',
  name: 'SSE Server',
  transport: { type: 'sse', url: 'https://mcp.example.com/sse' },
  timeout_ms: 30_000,
};

// ─── Tests ──────────────────────────────────────────────────────────

describe('MCPConnectionManager', () => {
  let registry: InMemoryMCPServerRegistry;
  let manager: MCPConnectionManager;

  beforeEach(() => {
    registry = new InMemoryMCPServerRegistry();
    manager = new MCPConnectionManager(registry);
    createdClients = [];
    vi.clearAllMocks();
  });

  // ── Built-in Tools ──

  describe('built-in tools', () => {
    it('resolves save_to_memory', async () => {
      const sources: ToolSource[] = [{ type: 'builtin', name: 'save_to_memory' }];
      const tools = await manager.resolveTools(sources);

      expect(tools).toHaveProperty('save_to_memory');
      const tool = tools.save_to_memory as Record<string, unknown>;
      expect(tool.description).toBe('Save data to workflow memory for later use');
      expect(typeof tool.execute).toBe('function');
    });

    it('save_to_memory execute returns expected shape', async () => {
      const sources: ToolSource[] = [{ type: 'builtin', name: 'save_to_memory' }];
      const tools = await manager.resolveTools(sources);
      const tool = tools.save_to_memory as { execute: (args: unknown) => Promise<unknown> };

      const result = await tool.execute({ key: 'test', value: 'data' });
      expect(result).toEqual({ key: 'test', value: 'data', saved: true });
    });

    it('returns empty for architect tools (handled separately)', async () => {
      const sources: ToolSource[] = [{ type: 'builtin', name: 'architect_draft_workflow' }];
      const tools = await manager.resolveTools(sources);
      expect(Object.keys(tools)).toHaveLength(0);
    });
  });

  // ── MCP Tool Resolution ──

  describe('MCP tool resolution', () => {
    it('resolves tools from a registered HTTP server', async () => {
      registry.register(httpServer);
      const sources: ToolSource[] = [{ type: 'mcp', server_id: 'server1' }];

      const tools = await manager.resolveTools(sources);

      expect(tools).toHaveProperty('search');
      expect(tools).toHaveProperty('fetch');
      expect(createdClients).toHaveLength(1);
    });

    it('filters tools by tool_names', async () => {
      registry.register(httpServer);
      const sources: ToolSource[] = [{
        type: 'mcp',
        server_id: 'server1',
        tool_names: ['search'],
      }];

      const tools = await manager.resolveTools(sources);

      expect(tools).toHaveProperty('search');
      expect(tools).not.toHaveProperty('fetch');
    });

    it('throws MCPServerNotFoundError for unregistered server', async () => {
      const sources: ToolSource[] = [{ type: 'mcp', server_id: 'nonexistent' }];

      await expect(manager.resolveTools(sources)).rejects.toThrow(MCPServerNotFoundError);
      await expect(manager.resolveTools(sources)).rejects.toThrow('nonexistent');
    });

    it('mixes built-in and MCP tools', async () => {
      registry.register(httpServer);
      const sources: ToolSource[] = [
        { type: 'builtin', name: 'save_to_memory' },
        { type: 'mcp', server_id: 'server1' },
      ];

      const tools = await manager.resolveTools(sources);

      expect(tools).toHaveProperty('save_to_memory');
      expect(tools).toHaveProperty('search');
      expect(tools).toHaveProperty('fetch');
    });
  });

  // ── Taint Wrapping ──

  describe('taint wrapping', () => {
    it('wraps MCP tool results with taint metadata', async () => {
      registry.register(httpServer);
      const sources: ToolSource[] = [{ type: 'mcp', server_id: 'server1' }];

      const tools = await manager.resolveTools(sources);
      const searchTool = tools.search as { execute: (args: unknown) => Promise<unknown> };
      const result = await searchTool.execute({ query: 'test' }) as Record<string, unknown>;

      expect(result).toHaveProperty('result');
      expect(result).toHaveProperty('taint');
      const taint = result.taint as Record<string, unknown>;
      expect(taint.source).toBe('mcp_tool');
      expect(taint.tool_name).toBe('search');
      expect(taint.server_id).toBe('server1');
      expect(typeof taint.created_at).toBe('string');
    });

    it('does not taint built-in tools', async () => {
      const sources: ToolSource[] = [{ type: 'builtin', name: 'save_to_memory' }];
      const tools = await manager.resolveTools(sources);
      const tool = tools.save_to_memory as { execute: (args: unknown) => Promise<unknown> };

      const result = await tool.execute({ key: 'k', value: 'v' }) as Record<string, unknown>;
      expect(result).not.toHaveProperty('taint');
      expect(result).toHaveProperty('saved', true);
    });
  });

  // ── Collision Namespacing ──

  describe('collision namespacing', () => {
    it('namespaces tools with __ when names collide across servers', async () => {
      registry.register(httpServer);
      registry.register(stdioServer);
      const sources: ToolSource[] = [
        { type: 'mcp', server_id: 'server1' },
        { type: 'mcp', server_id: 'server2' },
      ];

      const tools = await manager.resolveTools(sources);

      // 'search' exists in both servers → namespaced
      expect(tools).toHaveProperty('server1__search');
      expect(tools).toHaveProperty('server2__search');
      expect(tools).not.toHaveProperty('search');

      // Non-colliding tools remain un-namespaced
      expect(tools).toHaveProperty('fetch');
      expect(tools).toHaveProperty('calculate');
    });

    it('does not namespace when no collisions exist', async () => {
      registry.register(httpServer);
      const sources: ToolSource[] = [{
        type: 'mcp',
        server_id: 'server1',
        tool_names: ['fetch'],
      }];

      const tools = await manager.resolveTools(sources);
      expect(tools).toHaveProperty('fetch');
      expect(tools).not.toHaveProperty('server1__fetch');
    });
  });

  // ── Connection Reuse ──

  describe('connection reuse', () => {
    it('reuses client for same server across multiple resolveTools calls', async () => {
      registry.register(httpServer);

      await manager.resolveTools([{ type: 'mcp', server_id: 'server1' }]);
      await manager.resolveTools([{ type: 'mcp', server_id: 'server1' }]);

      // Only one client should have been created
      expect(createdClients).toHaveLength(1);
    });

    it('creates separate clients for different servers', async () => {
      registry.register(httpServer);
      registry.register(stdioServer);

      await manager.resolveTools([
        { type: 'mcp', server_id: 'server1' },
        { type: 'mcp', server_id: 'server2' },
      ]);

      expect(createdClients).toHaveLength(2);
    });
  });

  // ── Cleanup ──

  describe('closeAll', () => {
    it('closes all connected clients', async () => {
      registry.register(httpServer);
      registry.register(stdioServer);

      await manager.resolveTools([
        { type: 'mcp', server_id: 'server1' },
        { type: 'mcp', server_id: 'server2' },
      ]);

      await manager.closeAll();

      for (const { client } of createdClients) {
        expect(client.close).toHaveBeenCalledOnce();
      }
    });

    it('handles close errors gracefully', async () => {
      registry.register(httpServer);
      await manager.resolveTools([{ type: 'mcp', server_id: 'server1' }]);

      // Make close throw
      createdClients[0].client.close.mockRejectedValueOnce(new Error('close failed'));

      // Should not throw
      await expect(manager.closeAll()).resolves.not.toThrow();
    });

    it('clears internal state after closeAll', async () => {
      registry.register(httpServer);
      await manager.resolveTools([{ type: 'mcp', server_id: 'server1' }]);
      await manager.closeAll();

      // Resolving again should create a new client
      await manager.resolveTools([{ type: 'mcp', server_id: 'server1' }]);
      expect(createdClients).toHaveLength(2);
    });
  });

  // ── Empty Sources ──

  describe('edge cases', () => {
    it('returns empty tools for empty sources', async () => {
      const tools = await manager.resolveTools([]);
      expect(Object.keys(tools)).toHaveLength(0);
    });

    it('allows access when allowed_agents includes the agent', async () => {
      const restricted: MCPServerEntry = {
        ...httpServer,
        id: 'restricted-server',
        allowed_agents: ['agent-1', 'agent-2'],
      };
      registry.register(restricted);

      const sources: ToolSource[] = [{ type: 'mcp', server_id: 'restricted-server' }];
      const tools = await manager.resolveTools(sources, 'agent-1');
      expect(tools).toHaveProperty('search');
    });

    it('denies access when allowed_agents excludes the agent', async () => {
      const restricted: MCPServerEntry = {
        ...httpServer,
        id: 'restricted-server',
        allowed_agents: ['agent-1'],
      };
      registry.register(restricted);

      const sources: ToolSource[] = [{ type: 'mcp', server_id: 'restricted-server' }];
      await expect(manager.resolveTools(sources, 'agent-999')).rejects.toThrow(MCPAccessDeniedError);
    });

    it('denies access when agentId is not provided and allowed_agents is set', async () => {
      const restricted: MCPServerEntry = {
        ...httpServer,
        id: 'restricted-server',
        allowed_agents: ['agent-1'],
      };
      registry.register(restricted);

      const sources: ToolSource[] = [{ type: 'mcp', server_id: 'restricted-server' }];
      await expect(manager.resolveTools(sources)).rejects.toThrow(MCPAccessDeniedError);
    });

    it('allows unrestricted access when allowed_agents is not set', async () => {
      registry.register(httpServer); // no allowed_agents
      const sources: ToolSource[] = [{ type: 'mcp', server_id: 'server1' }];

      const tools = await manager.resolveTools(sources, 'any-agent');
      expect(tools).toHaveProperty('search');
    });

    it('handles filtered tool_names that do not exist on server', async () => {
      registry.register(httpServer);
      const sources: ToolSource[] = [{
        type: 'mcp',
        server_id: 'server1',
        tool_names: ['nonexistent_tool'],
      }];

      // Should not throw, just skip the missing tool
      const tools = await manager.resolveTools(sources);
      expect(tools).not.toHaveProperty('nonexistent_tool');
    });
  });
});
