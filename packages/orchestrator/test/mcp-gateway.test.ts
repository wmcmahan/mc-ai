import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPGatewayClient } from '../src/mcp/gateway-client.js';
import { MCPGatewayError, MCPToolExecutionError } from '../src/mcp/errors.js';

describe('MCPGatewayClient', () => {
  let client: MCPGatewayClient;

  beforeEach(() => {
    client = new MCPGatewayClient({ baseUrl: 'http://localhost:3001', retries: 0 });
    // Suppress structured log output during tests
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    test('should use provided base URL', () => {
      const c = new MCPGatewayClient({ baseUrl: 'http://custom:4000' });
      expect(c.getBaseUrl()).toBe('http://custom:4000');
    });

    test('should fallback to default URL', () => {
      const c = new MCPGatewayClient();
      expect(c.getBaseUrl()).toBe('http://localhost:3001');
    });
  });

  describe('listTools', () => {
    test('should parse tools response', async () => {
      const mockTools = [
        { name: 'calculator', description: 'Math operations', inputSchema: { type: 'object', properties: {} } },
        { name: 'search', description: 'Web search', inputSchema: { type: 'object', properties: {} } },
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockTools,
      } as Response);

      const tools = await client.listTools();

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('calculator');
      expect(tools[1].name).toBe('search');
    });

    test('should throw MCPGatewayError on HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Internal Server Error',
      } as Response);

      await expect(client.listTools()).rejects.toThrow(MCPGatewayError);
    });

    test('should throw MCPGatewayError on connection failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

      await expect(client.listTools()).rejects.toThrow(MCPGatewayError);
      await expect(client.listTools()).rejects.toThrow('Failed to connect');
    });
  });

  describe('executeTool', () => {
    test('should send parameters and return result', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ result: 42 }),
      } as Response);

      const result = await client.executeTool('calculator', { a: 20, b: 22 });

      expect(result).toBe(42);
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/tools/calculator/execute',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ parameters: { a: 20, b: 22 } }),
        })
      );
    });

    test('should throw MCPToolExecutionError on tool error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ error: 'Division by zero' }),
      } as Response);

      await expect(client.executeTool('calculator', { a: 1, b: 0 })).rejects.toThrow(MCPToolExecutionError);
      await expect(client.executeTool('calculator', { a: 1, b: 0 })).rejects.toThrow('Division by zero');
    });

    test('should throw MCPToolExecutionError on HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Tool not found',
      } as Response);

      await expect(client.executeTool('nonexistent', {})).rejects.toThrow(MCPGatewayError);
    });
  });

  describe('healthCheck', () => {
    test('should return true when gateway is healthy', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
      } as Response);

      const result = await client.healthCheck();
      expect(result).toBe(true);
    });

    test('should return false when gateway is down', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

      const result = await client.healthCheck();
      expect(result).toBe(false);
    });

    test('should return false on non-OK response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
      } as Response);

      const result = await client.healthCheck();
      expect(result).toBe(false);
    });
  });
});

describe('Error Classes', () => {
  test('MCPGatewayError has correct name', () => {
    const err = new MCPGatewayError('test error');
    expect(err.name).toBe('MCPGatewayError');
    expect(err.message).toBe('test error');
  });

  test('MCPToolExecutionError has correct name and toolName', () => {
    const err = new MCPToolExecutionError('calculator', 'overflow');
    expect(err.name).toBe('MCPToolExecutionError');
    expect(err.toolName).toBe('calculator');
    expect(err.message).toContain('calculator');
    expect(err.message).toContain('overflow');
  });
});
