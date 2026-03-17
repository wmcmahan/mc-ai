/**
 * Edge Condition Evaluator
 *
 * Evaluates edge conditions to determine routing in the graph.
 * Conditions are compiled via filtrex
 * with an LRU cache to avoid recompilation on repeated evaluations.
 *
 * Supported condition types:
 * - `always`: unconditionally true
 * - `conditional`: filtrex expression evaluated against workflow state
 * - `map`: syntactic sugar that delegates to `conditional`
 *
 * @module runner/conditions
 */

import { compileExpression, useDotAccessOperatorAndOptionalChaining } from 'filtrex';
import type { EdgeCondition } from '../types/graph.js';
import type { WorkflowState } from '../types/state.js';
import { createLogger } from '../utils/logger.js';
import { getTaintRegistry } from '../utils/taint.js';

const logger = createLogger('runner.conditions');

// ─── Expression Cache ───────────────────────────────────────────────

/**
 * LRU-style cache for compiled filtrex expressions.
 * Avoids recompiling the same condition string on every edge evaluation.
 */
const expressionCache = new Map<string, ReturnType<typeof compileExpression>>();
const MAX_CACHE_SIZE = 256;

/**
 * Compile and cache a filtrex expression.
 *
 * @param expression - The expression string to compile.
 * @returns A function that evaluates the expression against a data object.
 */
function getCompiledExpression(expression: string): ReturnType<typeof compileExpression> {
  const cached = expressionCache.get(expression);
  if (cached) return cached;

  const fn = compileExpression(expression, {
    customProp: useDotAccessOperatorAndOptionalChaining,
    extraFunctions: {
      length: (val: unknown) =>
        Array.isArray(val) ? val.length : typeof val === 'string' ? val.length : 0,
      lower: (val: unknown) =>
        typeof val === 'string' ? val.toLowerCase() : val,
      upper: (val: unknown) =>
        typeof val === 'string' ? val.toUpperCase() : val,
      typeof: (val: unknown) =>
        val === null ? 'null' : typeof val,
      includes: (arr: unknown, val: unknown) =>
        Array.isArray(arr) ? arr.includes(val) : false,
      number: (val: unknown) => {
        const n = Number(val);
        return Number.isNaN(n) ? 0 : n;
      },
    },
  });

  // Evict oldest entry if cache is full
  if (expressionCache.size >= MAX_CACHE_SIZE) {
    const oldest = expressionCache.keys().next().value;
    if (oldest !== undefined) expressionCache.delete(oldest);
  }

  expressionCache.set(expression, fn);
  return fn;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Evaluate an edge condition against the current workflow state.
 *
 * @example
 * ```ts
 * evaluateCondition({ type: 'conditional', condition: "memory.confidence > 0.8" }, state)
 * ```
 *
 * @param condition - The edge condition to evaluate.
 * @param state - Current workflow state.
 * @param options - Optional evaluation configuration.
 * @param options.strict_taint - When `true`, reject conditions that reference tainted memory keys.
 * @returns `true` if the edge should be followed.
 */
export function evaluateCondition(
  condition: EdgeCondition,
  state: WorkflowState,
  options?: { strict_taint?: boolean },
): boolean {
  switch (condition.type) {
    case 'always':
      return true;

    case 'conditional': {
      if (!condition.condition) return false;

      try {
        let expression = condition.condition;

        // Legacy compat: strip leading "$." JSONPath prefix
        if (expression.startsWith('$.')) {
          expression = expression.slice(2);
        }

        // Check for tainted keys referenced in the condition expression
        const taintRegistry = getTaintRegistry(state.memory);
        if (Object.keys(taintRegistry).length > 0) {
          const taintedKeysInExpr = Object.keys(taintRegistry).filter(
            key => expression.includes(`memory.${key}`) || expression.includes(key),
          );
          if (taintedKeysInExpr.length > 0) {
            if (options?.strict_taint) {
              logger.warn('tainted_condition_rejected', {
                condition: condition.condition,
                tainted_keys: taintedKeysInExpr,
                reason: 'strict_taint mode rejects conditions referencing tainted data',
              });
              return false;
            }
            logger.warn('tainted_condition_warning', {
              condition: condition.condition,
              tainted_keys: taintedKeysInExpr,
              hint: 'Condition references tainted memory keys — result may be influenced by untrusted data',
            });
          }
        }

        // Filtrex uses double quotes for string literals; convert
        // single-quoted strings for backward compatibility.
        expression = expression.replace(/'/g, '"');

        const fn = getCompiledExpression(expression);
        const result = fn(state);

        // filtrex with useDotAccessOperatorAndOptionalChaining may return
        // an Error object (e.g. UnknownPropertyError) instead of throwing.
        if (result instanceof Error) {
          logger.warn('condition_evaluation_property_error', {
            condition: condition.condition,
            error: result.message,
          });
          return false;
        }

        return Boolean(result);
      } catch (error) {
        logger.error('condition_evaluation_error', error, { condition: condition.condition });
        return false;
      }
    }

    case 'map':
      if (!condition.condition) return true;
      return evaluateCondition(
        { type: 'conditional', condition: condition.condition, value: condition.value },
        state,
      );

    default:
      return false;
  }
}
