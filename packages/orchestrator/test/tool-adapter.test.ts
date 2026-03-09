import { describe, test, expect, vi, afterEach } from 'vitest';
import { loadAgentTools, executeToolCall } from '../src/mcp/tool-adapter.js';

describe('loadAgentTools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should always include save_to_memory tool', async () => {
    const tools = await loadAgentTools([]);

    expect(tools.save_to_memory).toBeDefined();
    expect(tools.save_to_memory.description).toContain('memory');
    expect(tools.save_to_memory.parameters).toBeDefined();
  });

  test('should return only save_to_memory when no tool names provided', async () => {
    const tools = await loadAgentTools([]);

    expect(Object.keys(tools)).toEqual(['save_to_memory']);
  });

  test('should return only save_to_memory with empty array', async () => {
    const tools = await loadAgentTools();

    expect(Object.keys(tools)).toEqual(['save_to_memory']);
  });

  test('should gracefully handle MCP gateway failure', async () => {
    // Mock fetch to simulate gateway being down
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

    // Suppress structured log output during test
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tools = await loadAgentTools(['calculator']);

    // Should still have save_to_memory
    expect(tools.save_to_memory).toBeDefined();
    // Should not have calculator (gateway down)
    expect(tools.calculator).toBeUndefined();

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  test('should load MCP tools when gateway available', async () => {
    const mockTools = [
      {
        name: 'calculator',
        description: 'Math operations',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      },
    ];

    // Mock listTools response
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockTools,
    } as Response);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tools = await loadAgentTools(['calculator']);

    expect(tools.save_to_memory).toBeDefined();
    expect(tools.calculator).toBeDefined();
    expect(tools.calculator.description).toBe('Math operations');

    stdoutSpy.mockRestore();
  });

  test('should skip missing tool name', async () => {
    const mockTools = [
      {
        name: 'calculator',
        description: 'Math',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockTools,
    } as Response);

    // Suppress structured log output
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const tools = await loadAgentTools(['nonexistent']);

    expect(tools.nonexistent).toBeUndefined();
    // Verify structured log was sent to stderr (warn level)
    expect(stderrSpy).toHaveBeenCalled();
    const logOutput = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(logOutput).toContain('tool_not_found');
    expect(logOutput).toContain('nonexistent');

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});

describe('executeToolCall', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should handle save_to_memory locally', async () => {
    const result = await executeToolCall('save_to_memory', { key: 'test', value: 42 });

    expect(result).toEqual({ key: 'test', value: 42, saved: true });
  });

  test('should call MCP gateway for other tools', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ result: 42 }),
    } as Response);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const result = await executeToolCall('calculator', { a: 20, b: 22 });

    // MCP tool calls now return TaintedToolResult with taint metadata
    expect(result).toHaveProperty('result', 42);
    expect(result).toHaveProperty('taint');
    expect((result as any).taint.source).toBe('mcp_tool');
    expect((result as any).taint.tool_name).toBe('calculator');
    stdoutSpy.mockRestore();
  });

  test('should return error object on MCP failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'Division by zero' }),
    } as Response);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await executeToolCall('calculator', { a: 1, b: 0 });

    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('Division by zero');

    stderrSpy.mockRestore();
  });
});
