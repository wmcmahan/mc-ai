/**
 * Mock Tool Resolver
 *
 * Implements `ToolResolver` for recording runs — returns AI-SDK-compatible
 * tools whose `execute` functions call user-supplied canned response factories
 * keyed by tool name. Keeps the SUT network-free apart from the LLM call.
 *
 * Built-in tool sources (e.g., `save_to_memory`) are left to the real
 * resolver path — this mock only intercepts MCP-style declarations.
 *
 * @module sut/mock-tool-resolver
 */

import type { ToolResolver, ToolSource } from '@cycgraph/orchestrator';
import type { ToolResponseMap, ToolResponseFn } from './types.js';

interface MockToolSchema {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Build a permissive JSON-schema-shaped `parameters` object for a mock tool.
 * Recording doesn't validate args against a schema — the LLM is the source of
 * truth — so we accept any object.
 */
function permissiveParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

/**
 * Create a mock tool resolver that returns canned responses for the supplied
 * tool names. Use during recording so the LLM has tools to call but they don't
 * hit the real network.
 *
 * @param responses - Map of tool name → response factory.
 * @param descriptions - Optional human-readable descriptions per tool name,
 *                       passed to the LLM so it knows what each tool does.
 */
export function createMockToolResolver(
  responses: ToolResponseMap,
  descriptions: Record<string, string> = {},
): ToolResolver {
  const buildTool = (toolName: string, responseFn: ToolResponseFn): MockToolSchema => ({
    description: descriptions[toolName] ?? `Mock tool: ${toolName}`,
    parameters: permissiveParameters(),
    execute: async (args) => responseFn(args),
  });

  return {
    async resolveTools(sources: ToolSource[]): Promise<Record<string, unknown>> {
      const tools: Record<string, unknown> = {};

      for (const source of sources) {
        if (source.type === 'builtin') {
          // Built-in sources are resolved by the orchestrator itself. Skipping
          // them here means the real `save_to_memory` (etc.) implementations run.
          continue;
        }

        if (source.type === 'mcp') {
          const toolNames = source.tool_names ?? Object.keys(responses);
          for (const name of toolNames) {
            const fn = responses[name];
            if (!fn) continue;
            tools[name] = buildTool(name, fn);
          }
        }
      }

      return tools;
    },

    async closeAll(): Promise<void> {
      // Nothing to close; canned responses hold no resources.
    },
  };
}
