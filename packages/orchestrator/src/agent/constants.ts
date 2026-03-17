/**
 * Agent System Constants
 *
 * Centralizes configuration defaults that were previously hardcoded
 * across the agent subsystem. Environment variable overrides are
 * supported for operational tuning without code changes.
 *
 * @module agent/constants
 */

// ─── Cache ──────────────────────────────────────────────────────────────

/** Config cache TTL in milliseconds (default: 5 minutes). */
export const AGENT_CONFIG_CACHE_TTL_MS =
  parseInt(process.env.AGENT_CONFIG_CACHE_TTL_MS ?? '', 10) || 5 * 60 * 1000;

/** Max number of agent configs to keep in cache (default: 100). */
export const MAX_AGENT_CONFIG_CACHE_SIZE =
  parseInt(process.env.MAX_AGENT_CONFIG_CACHE_SIZE ?? '', 10) || 100;

/**
 * Shorter TTL for fallback configs so DB recovery is detected sooner
 * (default: 30 seconds).
 */
export const FALLBACK_CONFIG_CACHE_TTL_MS =
  parseInt(process.env.FALLBACK_CONFIG_CACHE_TTL_MS ?? '', 10) || 30 * 1000;

// ─── Default Agent Config ───────────────────────────────────────────────

/** Default LLM model identifier when none is specified. */
export const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-20250514';

/** Default LLM provider. */
export const DEFAULT_AGENT_PROVIDER = 'anthropic';

/** Default sampling temperature (0 = deterministic, 1 = creative). */
export const DEFAULT_AGENT_TEMPERATURE = 0.7;

/** Default maximum tool-call steps. */
export const DEFAULT_AGENT_MAX_STEPS = 10;

/** Default system prompt for agents without a configured prompt. */
export const DEFAULT_AGENT_SYSTEM_PROMPT =
  'You are a helpful AI assistant working in an orchestrated workflow. Execute your task and provide your response.';

// ─── Known Models ───────────────────────────────────────────────────────

/** Known OpenAI model identifiers for provider inference and validation. */
export const OPENAI_MODELS = [
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4',
  'o1-preview', 'o1-mini', 'o3', 'o3-mini', 'o4-mini',
];

/** Known Anthropic model identifiers for provider inference and validation. */
export const ANTHROPIC_MODELS = [
  'claude-opus-4-20250514', 'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
];

export const PROVIDERS_MODELS = {
  'openai': OPENAI_MODELS,
  'anthropic': ANTHROPIC_MODELS,
} as const;

// ─── Executor ───────────────────────────────────────────────────────────

/** Timeout for a single agent LLM invocation (default: 2 minutes). */
export const DEFAULT_AGENT_TIMEOUT_MS =
  parseInt(process.env.AGENT_TIMEOUT_MS ?? '', 10) || 2 * 60 * 1000;

/** Max serialized memory bytes injected into the system prompt (default: 50 KB). */
export const MAX_MEMORY_PROMPT_BYTES =
  parseInt(process.env.MAX_MEMORY_PROMPT_BYTES ?? '', 10) || 50 * 1024;

/** Max serialized bytes for a single memory value (default: 1 MB). */
export const MAX_MEMORY_VALUE_BYTES =
  parseInt(process.env.MAX_MEMORY_VALUE_BYTES ?? '', 10) || 1024 * 1024;
