/**
 * Forgiving Zod Structural Assertions
 *
 * Validates that LLM-generated tool calls match expected schemas
 * structurally (correct tool name, required params present, types
 * match) without asserting exact string value equality.
 *
 * @module assertions/zod-structural
 */

import type { ZodType } from 'zod';
import type { ZodStructuralResult, TypeMismatch } from './types.js';
import type { ToolCall } from '../dataset/types.js';

/**
 * Validates a single actual tool call against expected structural constraints.
 *
 * Rules:
 * 1. Tool name must match exactly
 * 2. All required parameters must be present
 * 3. Parameter types must match the schema
 * 4. Exact string values are NOT compared
 *
 * @param actual - The LLM-generated tool call to validate.
 * @param expected - The golden trajectory's expected tool call.
 * @param argSchema - Optional Zod schema for validating argument types.
 *                    If not provided, validates using the expected args
 *                    to infer expected types.
 */
export function assertToolCallStructure(
  actual: ToolCall,
  expected: ToolCall,
  argSchema?: ZodType,
): ZodStructuralResult {
  const toolName = expected.toolName;

  // 1. Check tool name match
  if (actual.toolName !== expected.toolName) {
    return {
      passed: false,
      toolName,
      missingParams: [],
      typeMismatches: [{
        param: '__toolName__',
        expected: expected.toolName,
        received: actual.toolName,
      }],
    };
  }

  // 2. If a Zod schema is provided, use it for structural validation
  if (argSchema) {
    return validateWithSchema(actual.args, argSchema, toolName);
  }

  // 3. Otherwise, infer structural expectations from the expected args
  return validateWithExpectedArgs(actual.args, expected.args, toolName);
}

/**
 * Validates args against a Zod schema, extracting only structural
 * violations (missing fields, wrong types).
 */
function validateWithSchema(
  actualArgs: Record<string, unknown>,
  schema: ZodType,
  toolName: string,
): ZodStructuralResult {
  const result = schema.safeParse(actualArgs);

  if (result.success) {
    return { passed: true, toolName, missingParams: [], typeMismatches: [] };
  }

  const missingParams: string[] = [];
  const typeMismatches: TypeMismatch[] = [];

  for (const issue of result.error.issues) {
    const paramPath = issue.path.join('.');

    if (issue.code === 'invalid_type') {
      // In Zod v4, invalid_type has `expected` but not `received`.
      // Resolve the actual value from the args to determine its type.
      const actualValue = getNestedValue(actualArgs, issue.path as (string | number)[]);

      if (actualValue === undefined) {
        missingParams.push(paramPath);
      } else {
        typeMismatches.push({
          param: paramPath,
          expected: issue.expected as string,
          received: typeOf(actualValue),
        });
      }
    }
    // Ignore other issue types (value-level validation like min/max/regex)
  }

  return {
    passed: missingParams.length === 0 && typeMismatches.length === 0,
    toolName,
    missingParams,
    typeMismatches,
  };
}

/**
 * Validates args against expected args by comparing presence and types,
 * not values. Used when no Zod schema is available.
 */
function validateWithExpectedArgs(
  actualArgs: Record<string, unknown>,
  expectedArgs: Record<string, unknown>,
  toolName: string,
): ZodStructuralResult {
  const missingParams: string[] = [];
  const typeMismatches: TypeMismatch[] = [];

  for (const [key, expectedValue] of Object.entries(expectedArgs)) {
    if (!(key in actualArgs)) {
      missingParams.push(key);
      continue;
    }

    const actualValue = actualArgs[key];
    const expectedType = typeOf(expectedValue);
    const actualType = typeOf(actualValue);

    if (expectedType !== actualType) {
      typeMismatches.push({
        param: key,
        expected: expectedType,
        received: actualType,
      });
    }
  }

  return {
    passed: missingParams.length === 0 && typeMismatches.length === 0,
    toolName,
    missingParams,
    typeMismatches,
  };
}

/**
 * Resolves a nested value from an object using a path array.
 */
function getNestedValue(obj: Record<string, unknown>, path: (string | number)[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/**
 * Returns a human-readable type string for a value.
 * Distinguishes null, array, and object.
 */
function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validates an entire trajectory's tool call sequence structurally.
 *
 * Compares the actual tool calls against the expected tool calls
 * from the golden trajectory, in order.
 *
 * @param actualToolCalls - The tool calls the LLM actually made.
 * @param expectedToolCalls - The golden trajectory's expected tool calls.
 * @returns Array of structural results, one per expected tool call.
 */
export function assertTrajectoryStructure(
  actualToolCalls: ToolCall[],
  expectedToolCalls: ToolCall[],
): ZodStructuralResult[] {
  return expectedToolCalls.map((expected, index) => {
    const actual = actualToolCalls[index];

    if (!actual) {
      return {
        passed: false,
        toolName: expected.toolName,
        missingParams: [],
        typeMismatches: [{
          param: '__call_index__',
          expected: `tool call at index ${index}`,
          received: 'missing',
        }],
      };
    }

    return assertToolCallStructure(actual, expected);
  });
}
