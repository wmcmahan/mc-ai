/**
 * Agent Factory
 *
 * Manages agent configurations and language-model instances for the
 * executor layer. Responsibilities:
 *
 * - Load agent configs from a pluggable {@link AgentRegistry} (with TTL cache)
 * - Create and cache {@link LanguageModel} instances per provider:model pair
 * - Provide fallback configs with deny-all permissions when an agent is
 *   missing (non-transient) or no registry is configured
 * - Propagate transient errors (DB down, network) so callers can retry
 *
 * @module agent-factory/agent-factory
 */

import type { LanguageModel } from 'ai';
import { AgentConfigSchema, type AgentConfig } from '../types.js';
import { createLogger } from '../../utils/logger.js';
import {
  AGENT_CONFIG_CACHE_TTL_MS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_TEMPERATURE,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  MAX_AGENT_CONFIG_CACHE_SIZE,
  FALLBACK_CONFIG_CACHE_TTL_MS,
} from '../constants.js';
import { isValidUUID } from './validation.js';
import { AgentNotFoundError, AgentLoadError, UnsupportedProviderError } from './errors.js';
import type { AgentRegistry } from '../../persistence/interfaces.js';
import { ProviderRegistry, createDefaultProviderRegistry } from '../provider-registry.js';

const logger = createLogger('agent.factory');

/** TTL-aware cache entry wrapping a cached value. */
interface CacheEntry<T> {
  /** The cached value. */
  value: T;
  /** Timestamp (ms) when the entry was created. */
  cachedAt: number;
  /** Fallback entries use a shorter TTL so DB recovery is detected sooner. */
  isFallback: boolean;
}

/**
 * Manages agent configurations and language-model instances.
 *
 * Use the singleton exported from `./index.ts` rather than constructing
 * directly — the singleton is wired into the executor and graph runner.
 */
export class AgentFactory {
  private modelCache = new Map<string, LanguageModel>();
  private configCache = new Map<string, CacheEntry<AgentConfig>>();
  private registry: AgentRegistry | null = null;
  private providerRegistry: ProviderRegistry = createDefaultProviderRegistry();

  /**
   * Configure the agent registry for database-backed agent loading.
   *
   * Call this once at startup. Without a registry, all agents use the
   * default config with deny-all permissions.
   *
   * @param registry - The persistence backend for agent configs.
   */
  setRegistry(registry: AgentRegistry): void {
    this.registry = registry;
  }

  /**
   * Configure a custom provider registry.
   *
   * Replaces the default registry (which has OpenAI + Anthropic).
   * Clears the model cache since providers may have changed.
   *
   * @param providerRegistry - The provider registry to use.
   */
  setProviderRegistry(providerRegistry: ProviderRegistry): void {
    this.providerRegistry = providerRegistry;
    this.modelCache.clear();
  }

  /**
   * Build a default agent config with deny-all permissions.
   *
   * Used as a fallback when the agent is not in the registry or the
   * registry is not configured. Deny-all (`read_keys: [], write_keys: []`)
   * ensures the agent cannot read or write any memory keys.
   *
   * @param agent_id - The ID to assign to the default config.
   * @returns A validated {@link AgentConfig} with sensible defaults.
   */
  getDefaultConfig(agent_id: string): AgentConfig {
    return {
      id: agent_id,
      name: agent_id,
      description: `Default agent config for ${agent_id}`,
      model: DEFAULT_AGENT_MODEL,
      provider: DEFAULT_AGENT_PROVIDER,
      system: DEFAULT_AGENT_SYSTEM_PROMPT,
      temperature: DEFAULT_AGENT_TEMPERATURE,
      maxSteps: DEFAULT_AGENT_MAX_STEPS,
      tools: [],
      read_keys: [],
      write_keys: [],
    };
  }

  /**
   * Load an agent config from the registry with caching and fallback.
   *
   * Resolution order:
   * 1. Return from cache if present and not expired.
   * 2. Query the registry if configured.
   * 3. Fall back to default config (deny-all) if the agent is not found.
   *
   * Transient errors (DB connection, network) are **not** caught —
   * they propagate as {@link AgentLoadError} to prevent silent data loss.
   *
   * @param agent_id - The UUID of the agent to load.
   * @returns A validated {@link AgentConfig}.
   * @throws {AgentLoadError} On transient registry failures or missing API keys.
   */
  async loadAgent(agent_id: string): Promise<AgentConfig> {
    try {
      if (!isValidUUID(agent_id)) {
        throw new AgentNotFoundError(agent_id);
      }

      // Check cache with TTL (fallback entries have shorter TTL)
      const cached = this.configCache.get(agent_id);
      if (cached) {
        const ttl = cached.isFallback ? FALLBACK_CONFIG_CACHE_TTL_MS : AGENT_CONFIG_CACHE_TTL_MS;
        if ((Date.now() - cached.cachedAt) < ttl) {
          return cached.value;
        }
        this.configCache.delete(agent_id);
      }

      // If no registry is configured, fall back to default
      if (!this.registry) {
        logger.warn('no_registry_fallback', { agent_id });
        return this.cacheAndReturn(agent_id, this.getDefaultConfig(agent_id), true);
      }

      // Load from registry
      const dbAgent = await this.registry.loadAgent(agent_id);

      if (!dbAgent) {
        throw new AgentNotFoundError(agent_id);
      }

      // Permissions are nullable — default to deny-all
      const permissions = dbAgent.permissions ?? { read_keys: [], write_keys: [] };

      const config: AgentConfig = {
        id: dbAgent.id,
        name: dbAgent.name,
        description: dbAgent.description || '',
        model: dbAgent.model,
        provider: dbAgent.provider || this.inferProvider(dbAgent.model),
        system: dbAgent.system_prompt,
        temperature: dbAgent.temperature,
        maxSteps: dbAgent.max_steps,
        tools: dbAgent.tools,
        read_keys: permissions.read_keys ?? [],
        write_keys: permissions.write_keys ?? [],
      };

      const validated = AgentConfigSchema.parse(config);
      logger.info('agent_loaded', { agent_id, model: validated.model, provider: validated.provider });
      return this.cacheAndReturn(agent_id, validated, false);
    } catch (error) {
      // AgentNotFoundError is a known, permanent error — fall back to default
      if (error instanceof AgentNotFoundError) {
        logger.warn('agent_not_found_fallback', { agent_id });
        return this.cacheAndReturn(agent_id, this.getDefaultConfig(agent_id), true);
      }

      // Transient errors (DB connection, schema, network) — propagate up.
      // Do NOT silently fall back: running an agent with deny-all permissions
      // because of a momentary DB hiccup produces silent data loss.
      logger.error('agent_load_failed', error, { agent_id });
      throw new AgentLoadError(agent_id, error);
    }
  }

  /**
   * Get or create a cached {@link LanguageModel} for the given config.
   *
   * Models are cached by `provider:model` key, so two agents sharing the
   * same provider and model string share a single SDK instance.
   *
   * @param config - The agent config specifying provider and model.
   * @returns A ready-to-use {@link LanguageModel}.
   * @throws {AgentLoadError} If the required API key env var is not set.
   * @throws {UnsupportedProviderError} If the provider is unrecognised.
   */
  getModel(config: AgentConfig): LanguageModel {
    const cacheKey = `${config.provider}:${config.model}`;

    if (!this.modelCache.has(cacheKey)) {
      this.evictIfNeeded(this.modelCache);
      this.modelCache.set(cacheKey, this.createModel(config));
    }

    return this.modelCache.get(cacheKey)!;
  }

  /** Clear both the config and model caches (useful in tests). */
  clearCache(): void {
    this.modelCache.clear();
    this.configCache.clear();
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  /**
   * Infer provider from model name using the provider registry's
   * registered prefixes. Falls back to {@link DEFAULT_AGENT_PROVIDER}
   * when no prefix matches.
   *
   * @param model - The model identifier string.
   * @returns The inferred provider name.
   */
  private inferProvider(model: string): string {
    const inferred = this.providerRegistry.inferProvider(model);
    if (inferred) return inferred;

    logger.warn('provider_inference_fallback', { model, defaulting_to: DEFAULT_AGENT_PROVIDER });
    return DEFAULT_AGENT_PROVIDER;
  }

  /**
   * Create a language model instance via the provider registry.
   *
   * @param config - The agent config specifying provider and model.
   * @returns A new {@link LanguageModel}.
   * @throws {UnsupportedProviderError} If the provider is not registered.
   * @throws {AgentLoadError} If model creation fails (e.g. missing API key).
   */
  private createModel(config: AgentConfig): LanguageModel {
    try {
      return this.providerRegistry.createModel(config.provider, config.model);
    } catch (error) {
      if (error instanceof UnsupportedProviderError) throw error;
      throw new AgentLoadError(config.id, error);
    }
  }

  /**
   * Validate, cache, and return an agent config.
   *
   * @param agent_id - The agent ID (cache key).
   * @param config - The raw config to validate and cache.
   * @param isFallback - Whether this is a fallback config (shorter TTL).
   * @returns The validated {@link AgentConfig}.
   */
  private cacheAndReturn(agent_id: string, config: AgentConfig, isFallback: boolean): AgentConfig {
    const validated = AgentConfigSchema.parse(config);
    this.evictIfNeeded(this.configCache);
    this.configCache.set(agent_id, { value: validated, cachedAt: Date.now(), isFallback });
    return validated;
  }

  /**
   * Evict the oldest entry if the cache has reached capacity.
   *
   * Uses insertion-order eviction (Maps iterate in insertion order),
   * which approximates FIFO.
   *
   * @param cache - The cache map to potentially evict from.
   */
  private evictIfNeeded<T>(cache: Map<string, T>): void {
    if (cache.size >= MAX_AGENT_CONFIG_CACHE_SIZE) {
      const oldestCacheKey = cache.keys().next().value;
      if (oldestCacheKey !== undefined) {
        cache.delete(oldestCacheKey);
        logger.debug('cache_evicted', { key: oldestCacheKey, cache_size: cache.size });
      }
    }
  }
}
