/**
 * LLM Provider Registry
 *
 * A runtime registry for Vercel AI SDK-compatible LLM providers.
 * Any provider can be registered with a factory function and optional
 * model-name prefixes for auto-inference.
 *
 * Built-in OpenAI and Anthropic providers are pre-registered via
 * {@link registerBuiltInProviders}. API keys are resolved lazily at
 * model-creation time (not at registration time).
 *
 * @module agent/provider-registry
 */

import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  OPENAI_MODEL_PREFIXES,
  ANTHROPIC_MODEL_PREFIXES,
} from './constants.js';
import { UnsupportedProviderError } from './agent-factory/errors.js';

/** Configuration for a registered LLM provider. */
export interface ProviderRegistration {
  /** Creates a LanguageModel instance for the given model ID. */
  createLanguageModel: (modelId: string) => LanguageModel;
  /** Model name prefixes for auto-inference (e.g., ['gpt-', 'o1-']). */
  modelPrefixes?: string[];
}

/**
 * Runtime registry for LLM providers.
 *
 * Consumers register providers by name with a factory function. The
 * {@link AgentFactory} delegates model creation to this registry,
 * eliminating the hardcoded provider switch.
 */
export class ProviderRegistry {
  private providers = new Map<string, ProviderRegistration>();

  /** Register a provider by name. Overwrites if already registered. */
  register(name: string, registration: ProviderRegistration): void {
    this.providers.set(name, registration);
  }

  /** Check if a provider is registered. */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** Remove a registered provider. Returns true if it existed. */
  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  /** List all registered provider names. */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Create a LanguageModel for the given provider and model ID.
   *
   * @throws {UnsupportedProviderError} If the provider is not registered.
   */
  createModel(providerName: string, modelId: string): LanguageModel {
    const registration = this.providers.get(providerName);
    if (!registration) {
      throw new UnsupportedProviderError(providerName);
    }
    return registration.createLanguageModel(modelId);
  }

  /**
   * Infer provider name from model ID using registered prefixes.
   *
   * @returns The provider name, or `null` if no prefix matches.
   */
  inferProvider(modelId: string): string | null {
    const m = modelId.toLowerCase();
    for (const [name, reg] of this.providers) {
      if (reg.modelPrefixes?.some(p => m.startsWith(p))) {
        return name;
      }
    }
    return null;
  }
}

/**
 * Register the built-in OpenAI and Anthropic providers.
 *
 * API keys are resolved lazily at model-creation time so that
 * registration never throws. This preserves the existing error
 * behavior where missing keys are caught when `getModel()` is called.
 */
export function registerBuiltInProviders(registry: ProviderRegistry): void {
  registry.register('openai', {
    createLanguageModel: (modelId: string) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
      }
      return createOpenAI({ apiKey })(modelId);
    },
    modelPrefixes: OPENAI_MODEL_PREFIXES,
  });

  registry.register('anthropic', {
    createLanguageModel: (modelId: string) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is not set');
      }
      return createAnthropic({ apiKey })(modelId);
    },
    modelPrefixes: ANTHROPIC_MODEL_PREFIXES,
  });
}

/** Create a ProviderRegistry with built-in providers pre-registered. */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltInProviders(registry);
  return registry;
}
