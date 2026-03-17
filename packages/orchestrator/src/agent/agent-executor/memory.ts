/**
 * Memory Extraction
 *
 * Extracts structured memory updates from an agent's `save_to_memory` tool
 * calls. Only `save_to_memory` calls produce memory writes — all other tool
 * results are stored in `action.metadata` to prevent permission bypass.
 *
 * @module agent-executor/memory
 */

import { createLogger } from '../../utils/logger.js';
import { sanitizeString } from './sanitizers.js';

const logger = createLogger('agent.executor');

/**
 * Extract memory updates from an agent's response and tool calls.
 *
 * Processing rules:
 * 1. Only `save_to_memory` tool calls produce memory writes.
 * 2. Keys prefixed with `_` are blocked (reserved for system use).
 * 3. Keys not in `allowedKeys` are silently dropped with a warning log.
 * 4. If no `save_to_memory` calls produced updates and the agent returned
 *    text, the raw response is stored under `fallbackKey`.
 *
 * @param agentResponse - The raw text response from the agent.
 * @param toolCalls - All tool calls made across every step of the agent execution.
 * @param allowedKeys - The agent's configured `write_keys`.
 * @param fallbackKey - Key for storing the raw response when no memory
 *   updates were extracted (defaults to `'agent_response'`).
 * @returns A record of memory key → value updates.
 */
export function extractMemoryUpdates(
  agentResponse: string,
  toolCalls: Array<{ toolCallId: string; toolName: string; args?: unknown; input?: unknown }>,
  allowedKeys: string[],
  fallbackKey: string = 'agent_response',
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};

  // Extract from save_to_memory tool calls
  for (const toolCall of toolCalls) {
    if (toolCall.toolName === 'save_to_memory') {
      // AI SDK v6 steps use `input` for tool call arguments, not `args`
      const args = (toolCall.input ?? toolCall.args ?? {}) as Record<string, unknown>;
      const key = args.key;
      const value = args.value;

      if (!key || typeof key !== 'string') {
        logger.warn('invalid_memory_key', { key, tool_call_id: toolCall.toolCallId });
        continue;
      }

      // Block internal key prefix to prevent permission bypass
      if (key.startsWith('_')) {
        logger.warn('blocked_internal_key_write', { key });
        continue;
      }

      // Validate Zero Trust permission
      if (allowedKeys.includes('*') || allowedKeys.includes(key)) {
        updates[key] = value;
      } else {
        logger.warn('unauthorized_key_write', { key, allowed: allowedKeys });
      }
    }
  }

  // Fallback: Store raw response if no memory updates.
  // Prefers the node-specific fallback key (e.g. "research_output"). If that
  // isn't in write_keys and the agent has exactly one non-wildcard write key,
  // uses that key instead (unambiguous intent). For multi-key agents we don't
  // guess — the response is dropped and logged.
  if (Object.keys(updates).length === 0 && agentResponse.trim()) {
    let targetKey = fallbackKey;
    if (!allowedKeys.includes('*') && !allowedKeys.includes(fallbackKey)) {
      const concreteKeys = allowedKeys.filter((k) => k !== '*');
      if (concreteKeys.length === 1) {
        targetKey = concreteKeys[0];
      } else {
        logger.warn('fallback_key_not_in_write_keys', {
          fallbackKey,
          allowedKeys,
          reason: 'ambiguous — agent has multiple write keys, cannot auto-select',
        });
      }
    }
    if (allowedKeys.includes('*') || allowedKeys.includes(targetKey)) {
      updates[targetKey] = sanitizeString(agentResponse);
    }
  }

  return updates;
}
