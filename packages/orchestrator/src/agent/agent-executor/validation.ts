/**
 * Zero Trust Permission Validation
 *
 * Enforces the agent permission model by verifying that every memory key
 * written by an agent is present in its `write_keys` allow-list.
 *
 * Internal keys (prefixed with `_`) are system-generated (e.g. `_taint_registry`)
 * and are exempt from agent permission checks.
 *
 * @module agent-executor/validation
 */

import type { Action } from '../../types/state.js';
import { PermissionDeniedError } from './errors.js';

/**
 * Validate that an action's memory updates only write to keys the agent
 * is authorised to modify.
 *
 * @param action - The action produced by the agent executor.
 * @param allowedKeys - The agent's configured `write_keys`. A single `'*'`
 *   entry grants wildcard access.
 * @throws {PermissionDeniedError} If the action writes to any key not in
 *   `allowedKeys` (excluding internal `_`-prefixed keys).
 */
export function validateMemoryUpdatePermissions(action: Action, allowedKeys: string[]): void {
  if (action.type !== 'update_memory') {
    return;
  }

  const updates = action.payload?.updates as Record<string, unknown> | undefined;
  if (!updates || typeof updates !== 'object') {
    return;
  }

  // Filter out internal keys (system-generated, not agent-controlled)
  const agentKeys = Object.keys(updates).filter(k => !k.startsWith('_'));

  // Wildcard permission
  if (allowedKeys.includes('*')) {
    return;
  }

  // Check each agent-written key
  const unauthorized = agentKeys.filter(k => !allowedKeys.includes(k));

  if (unauthorized.length > 0) {
    throw new PermissionDeniedError(
      `Agent attempted to write to unauthorized keys: ${unauthorized.join(', ')}`
    );
  }
}
