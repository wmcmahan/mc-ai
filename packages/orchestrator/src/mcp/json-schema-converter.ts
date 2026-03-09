/**
 * JSON Schema → Zod Converter
 *
 * Required because the AI SDK v6 `tool()` function expects Zod schemas
 * for input validation, while MCP tools provide JSON Schema definitions.
 * This converter bridges the gap at tool-loading time.
 *
 * Supported type mappings:
 * | JSON Schema      | Zod equivalent                   |
 * |------------------|----------------------------------|
 * | `object`         | `z.object({…})` (recursive)      |
 * | `string`         | `z.string()` or `z.enum([…])`    |
 * | `number`/`integer` | `z.number()`                  |
 * | `boolean`        | `z.boolean()`                    |
 * | `array`          | `z.array(itemSchema)`            |
 * | Unknown          | `z.any()` (graceful fallback)    |
 *
 * @module mcp/json-schema-converter
 */

import { z } from 'zod';
import type { JSONSchema } from './gateway-client.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcp.schema');

/**
 * Convert a JSON Schema object to a Zod schema.
 *
 * This is the public entry point. It delegates to type-specific converters
 * and falls back to `z.any()` on unrecognised types (never throws).
 *
 * @param schema - JSON Schema object from an MCP tool definition.
 * @returns Equivalent Zod schema for AI SDK compatibility.
 */
export function jsonSchemaToZod(schema: JSONSchema): z.ZodType {
  try {
    switch (schema.type) {
      case 'object':
        return convertObjectSchema(schema);

      case 'string':
        return convertStringSchema(schema);

      case 'number':
      case 'integer':
        return z.number();

      case 'boolean':
        return z.boolean();

      case 'array':
        return convertArraySchema(schema);

      default:
        logger.warn('unsupported_schema_type', { type: schema.type });
        return z.any();
    }
  } catch (error) {
    logger.warn('schema_conversion_error', { error: error instanceof Error ? error.message : String(error) });
    return z.any();
  }
}

/**
 * Convert a JSON Schema `object` type to `z.object()`.
 *
 * Recursively converts each property, applies `.describe()` if a
 * description is present, and marks non-required properties as `.optional()`.
 */
function convertObjectSchema(schema: JSONSchema): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const [key, propSchema] of Object.entries(properties)) {
    let zodType = jsonSchemaToZod(propSchema);

    if (propSchema.description) {
      zodType = zodType.describe(propSchema.description);
    }

    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return z.object(shape);
}

/**
 * Convert a JSON Schema `string` type to `z.string()` or `z.enum()`.
 *
 * If the schema has an `enum` constraint with at least one value,
 * returns `z.enum()` instead of `z.string()`.
 */
function convertStringSchema(schema: JSONSchema): z.ZodType {
  if (schema.enum && schema.enum.length > 0) {
    return z.enum(schema.enum as [string, ...string[]]);
  }

  return z.string();
}

/**
 * Convert a JSON Schema `array` type to `z.array()`.
 *
 * Falls back to `z.array(z.any())` if no `items` schema is specified.
 */
function convertArraySchema(schema: JSONSchema): z.ZodArray<z.ZodType> {
  if (!schema.items) {
    return z.array(z.any());
  }

  return z.array(jsonSchemaToZod(schema.items));
}
