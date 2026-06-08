/**
 * Unit tests for orchestrator-sut helpers.
 *
 * Validates the pure pieces of the SUT — output extraction and mock tool
 * resolution — without spinning up a GraphRunner. Full end-to-end
 * verification happens in the recording script's smoke run, which calls a
 * real LLM and is exercised manually.
 */

import { describe, it, expect } from 'vitest';
import { extractOutput } from '../../src/sut/orchestrator-sut.js';
import { createMockToolResolver } from '../../src/sut/mock-tool-resolver.js';
import { buildSingleAgentGraph } from '../../src/sut/graphs/single-agent.js';

describe('extractOutput', () => {
  it('returns a string value verbatim', () => {
    const memory = { response: 'Hello, world.' };
    expect(extractOutput(memory, 'response')).toBe('Hello, world.');
  });

  it('JSON-serializes object values for predictable comparison', () => {
    const memory = { result: { branch: 'clean', reason: 'data has nulls' } };
    expect(extractOutput(memory, 'result')).toBe(
      '{"branch":"clean","reason":"data has nulls"}',
    );
  });

  it('joins multiple keys with a blank line', () => {
    const memory = { notes: 'A', draft: 'B' };
    expect(extractOutput(memory, ['notes', 'draft'])).toBe('A\n\nB');
  });

  it('silently skips missing keys', () => {
    const memory = { notes: 'A' };
    expect(extractOutput(memory, ['notes', 'missing'])).toBe('A');
  });

  it('returns empty string when no requested keys are present', () => {
    expect(extractOutput({}, 'response')).toBe('');
  });

  it('ignores undefined values but keeps empty strings', () => {
    const memory = { a: undefined, b: '' };
    // Undefined skipped; empty string is a valid value and contributes an empty part
    expect(extractOutput(memory, ['a', 'b'])).toBe('');
  });
});

describe('createMockToolResolver', () => {
  it('returns canned tools for MCP-typed sources', async () => {
    const resolver = createMockToolResolver({
      web_search: (args) => ({ results: [`mocked: ${args.query}`] }),
    });

    const tools = await resolver.resolveTools([
      { type: 'mcp', server_id: 'mock', tool_names: ['web_search'] },
    ]);

    expect(tools).toHaveProperty('web_search');
    const webSearch = tools.web_search as {
      description: string;
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };
    expect(webSearch.description).toContain('web_search');
    const result = await webSearch.execute({ query: 'test' });
    expect(result).toEqual({ results: ['mocked: test'] });
  });

  it('uses caller-supplied descriptions when present', async () => {
    const resolver = createMockToolResolver(
      { web_search: () => ({}) },
      { web_search: 'Search the web for information' },
    );

    const tools = await resolver.resolveTools([
      { type: 'mcp', server_id: 'mock', tool_names: ['web_search'] },
    ]);

    expect((tools.web_search as { description: string }).description).toBe(
      'Search the web for information',
    );
  });

  it('returns all canned tools when tool_names is omitted', async () => {
    const resolver = createMockToolResolver({
      web_search: () => ({}),
      delegate_to_agent: () => ({}),
    });

    const tools = await resolver.resolveTools([
      { type: 'mcp', server_id: 'mock' },
    ]);

    expect(Object.keys(tools).sort()).toEqual([
      'delegate_to_agent',
      'web_search',
    ]);
  });

  it('skips builtin-typed sources (orchestrator resolves them)', async () => {
    const resolver = createMockToolResolver({ web_search: () => ({}) });

    const tools = await resolver.resolveTools([
      { type: 'builtin', name: 'save_to_memory' },
    ]);

    expect(tools).toEqual({});
  });

  it('skips unknown tool names without throwing', async () => {
    const resolver = createMockToolResolver({ web_search: () => ({}) });

    const tools = await resolver.resolveTools([
      { type: 'mcp', server_id: 'mock', tool_names: ['unknown_tool'] },
    ]);

    expect(tools).toEqual({});
  });

  it('closeAll is a no-op that does not throw', async () => {
    const resolver = createMockToolResolver({});
    await expect(resolver.closeAll()).resolves.toBeUndefined();
  });
});

describe('buildSingleAgentGraph', () => {
  it('produces a runnable graph + state + registry from minimal input', () => {
    const artifacts = buildSingleAgentGraph({
      input: 'Summarize the Treaty of Westphalia in 100 words.',
    });

    expect(artifacts.graph.nodes).toHaveLength(1);
    expect(artifacts.graph.nodes[0].type).toBe('agent');
    expect(artifacts.graph.start_node).toBe('agent');
    expect(artifacts.outputKey).toBe('response');
    expect(artifacts.initialState.goal).toBe(
      'Summarize the Treaty of Westphalia in 100 words.',
    );
    expect(artifacts.initialState.workflow_id).toBe(artifacts.graph.id);
  });

  it('threads tool declarations through to the agent config', async () => {
    const artifacts = buildSingleAgentGraph({
      input: 'Find the latest news on TypeScript.',
      tools: [{ type: 'mcp', server_id: 'mock', tool_names: ['web_search'] }],
    });

    const agentNode = artifacts.graph.nodes[0];
    if (agentNode.type !== 'agent') throw new Error('expected agent node');
    const agent = await artifacts.agentRegistry.loadAgent(agentNode.agent_id);
    expect(agent).not.toBeNull();
    expect(agent!.tools).toEqual([
      { type: 'mcp', server_id: 'mock', tool_names: ['web_search'] },
    ]);
  });

  it('uses a custom outputKey when provided', () => {
    const artifacts = buildSingleAgentGraph({
      input: 'Translate "hello" to French.',
      outputKey: 'translation',
    });

    expect(artifacts.outputKey).toBe('translation');
    const agentNode = artifacts.graph.nodes[0];
    expect(agentNode.write_keys).toEqual(['translation']);
  });
});
