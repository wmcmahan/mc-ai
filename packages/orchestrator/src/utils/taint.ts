/**
 * Taint Tracking Utilities
 *
 * Manages a taint registry stored at `memory._taint_registry`.
 * External data (MCP tool results, etc.) is marked as tainted so
 * downstream consumers (supervisors, agents) know not to trust it
 * for routing decisions or security-sensitive operations.
 *
 * The registry key `_taint_registry` is protected by the existing
 * agent-executor rule that blocks writes to keys starting with `_`.
 *
 * @module utils/taint
 */

import type { TaintMetadata, TaintRegistry } from '../types/state.js';

/** Well-known memory key for the taint registry. */
const TAINT_REGISTRY_KEY = '_taint_registry';

/**
 * Mark a memory key as tainted with source metadata.
 *
 * Mutates `memory` in place by writing the updated registry back to
 * `memory._taint_registry`.
 *
 * @param memory - Workflow memory object.
 * @param key - Memory key to mark as tainted.
 * @param meta - Provenance metadata for the tainted value.
 */
export function markTainted(
  memory: Record<string, unknown>,
  key: string,
  meta: TaintMetadata,
): void {
  const registry = getTaintRegistry(memory);
  registry[key] = meta;
  memory[TAINT_REGISTRY_KEY] = registry;
}

/**
 * Check if a memory key is tainted.
 *
 * @param memory - Workflow memory object.
 * @param key - Memory key to check.
 * @returns `true` if the key has an entry in the taint registry.
 */
export function isTainted(
  memory: Record<string, unknown>,
  key: string,
): boolean {
  const registry = getTaintRegistry(memory);
  return key in registry;
}

/**
 * Get the full taint registry from memory.
 *
 * Returns an empty object if no registry exists or the stored value
 * is not a plain object.
 *
 * @param memory - Workflow memory object.
 * @returns The taint registry (may be empty).
 */
export function getTaintRegistry(
  memory: Record<string, unknown>,
): TaintRegistry {
  const raw = memory[TAINT_REGISTRY_KEY];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as TaintRegistry;
  }
  return {};
}

/**
 * Get taint metadata for a specific memory key.
 *
 * @param memory - Workflow memory object.
 * @param key - Memory key to look up.
 * @returns Taint metadata, or `undefined` if the key is not tainted.
 */
export function getTaintInfo(
  memory: Record<string, unknown>,
  key: string,
): TaintMetadata | undefined {
  const registry = getTaintRegistry(memory);
  return registry[key];
}

/**
 * Propagate taint from input memory keys to output keys.
 *
 * If **any** of the agent's readable memory keys are tainted, all
 * `outputKeys` are marked as `derived`-tainted (the agent may have
 * incorporated tainted data into its output).
 *
 * @param memory - Workflow memory object.
 * @param outputKeys - Memory keys written by the agent.
 * @param agentId - ID of the agent that produced the outputs.
 * @returns Partial taint registry with only the new entries (empty if no taint propagated).
 */
export function propagateDerivedTaint(
  memory: Record<string, unknown>,
  outputKeys: string[],
  agentId: string,
): TaintRegistry {
  const registry = getTaintRegistry(memory);
  const hasTaintedInputs = Object.keys(memory).some(
    k => k in registry && k !== TAINT_REGISTRY_KEY,
  );

  if (!hasTaintedInputs) {
    return {};
  }

  const newEntries: TaintRegistry = {};
  const now = new Date().toISOString();

  for (const key of outputKeys) {
    if (key === TAINT_REGISTRY_KEY) continue;
    newEntries[key] = {
      source: 'derived',
      agent_id: agentId,
      created_at: now,
    };
  }

  return newEntries;
}
