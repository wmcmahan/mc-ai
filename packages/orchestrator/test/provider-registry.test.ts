import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ProviderRegistry,
  registerBuiltInProviders,
  createDefaultProviderRegistry,
} from '../src/agent/provider-registry.js';
import { UnsupportedProviderError } from '../src/agent/agent-factory/errors.js';
import type { LanguageModel } from 'ai';

// Mock the AI SDK providers
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => (model: string) => ({ provider: 'openai', modelId: model })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => (model: string) => ({ provider: 'anthropic', modelId: model })),
}));

/** Helper: create a stub LanguageModel. */
function stubModel(id: string): LanguageModel {
  return { provider: 'stub', modelId: id } as unknown as LanguageModel;
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  // ─── Registration ──────────────────────────────────────────────────

  describe('register / has / listProviders', () => {
    it('registers a provider and reports it via has() and listProviders()', () => {
      registry.register('groq', {
        createLanguageModel: (id) => stubModel(id),
      });

      expect(registry.has('groq')).toBe(true);
      expect(registry.listProviders()).toContain('groq');
    });

    it('returns false for unregistered providers', () => {
      expect(registry.has('missing')).toBe(false);
    });

    it('overwrites an existing registration with the same name', () => {
      const first = vi.fn(() => stubModel('a'));
      const second = vi.fn(() => stubModel('b'));

      registry.register('test', { createLanguageModel: first });
      registry.register('test', { createLanguageModel: second });

      registry.createModel('test', 'any');
      expect(second).toHaveBeenCalledWith('any');
      expect(first).not.toHaveBeenCalled();
    });
  });

  // ─── Model Creation ────────────────────────────────────────────────

  describe('createModel', () => {
    it('delegates to the registered createLanguageModel function', () => {
      const factory = vi.fn((id: string) => stubModel(id));
      registry.register('custom', { createLanguageModel: factory });

      const model = registry.createModel('custom', 'my-model');
      expect(factory).toHaveBeenCalledWith('my-model');
      expect(model).toBeDefined();
    });

    it('throws UnsupportedProviderError for unregistered providers', () => {
      expect(() => registry.createModel('nonexistent', 'model'))
        .toThrow(UnsupportedProviderError);
    });
  });

  // ─── Unregister ────────────────────────────────────────────────────

  describe('unregister', () => {
    it('removes a provider and returns true', () => {
      registry.register('temp', { createLanguageModel: () => stubModel('x') });
      expect(registry.unregister('temp')).toBe(true);
      expect(registry.has('temp')).toBe(false);
    });

    it('returns false when provider does not exist', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  // ─── Prefix Inference ─────────────────────────────────────────────

  describe('inferProvider', () => {
    beforeEach(() => {
      registry.register('openai', {
        createLanguageModel: () => stubModel('x'),
        modelPrefixes: ['gpt-', 'o1-', 'o3-'],
      });
      registry.register('anthropic', {
        createLanguageModel: () => stubModel('x'),
        modelPrefixes: ['claude-'],
      });
    });

    it('infers openai from gpt- prefix', () => {
      expect(registry.inferProvider('gpt-4-turbo')).toBe('openai');
    });

    it('infers openai from o1- prefix', () => {
      expect(registry.inferProvider('o1-preview')).toBe('openai');
    });

    it('infers anthropic from claude- prefix', () => {
      expect(registry.inferProvider('claude-3-5-sonnet')).toBe('anthropic');
    });

    it('returns null for unknown prefixes', () => {
      expect(registry.inferProvider('llama-3-70b')).toBeNull();
    });

    it('is case-insensitive', () => {
      expect(registry.inferProvider('GPT-4')).toBe('openai');
      expect(registry.inferProvider('Claude-3')).toBe('anthropic');
    });

    it('works with custom provider prefixes', () => {
      registry.register('groq', {
        createLanguageModel: () => stubModel('x'),
        modelPrefixes: ['llama-', 'mixtral-'],
      });
      expect(registry.inferProvider('llama-3-70b')).toBe('groq');
      expect(registry.inferProvider('mixtral-8x7b')).toBe('groq');
    });
  });
});

// ─── Built-in Providers ─────────────────────────────────────────────

describe('registerBuiltInProviders', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('registers openai and anthropic providers', () => {
    registerBuiltInProviders(registry);
    expect(registry.has('openai')).toBe(true);
    expect(registry.has('anthropic')).toBe(true);
  });

  it('creates models when API keys are set', () => {
    registerBuiltInProviders(registry);
    expect(registry.createModel('openai', 'gpt-4')).toBeDefined();
    expect(registry.createModel('anthropic', 'claude-3')).toBeDefined();
  });

  it('throws when OPENAI_API_KEY is missing', () => {
    delete process.env.OPENAI_API_KEY;
    registerBuiltInProviders(registry);
    expect(() => registry.createModel('openai', 'gpt-4'))
      .toThrow('OPENAI_API_KEY environment variable is not set');
  });

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    delete process.env.ANTHROPIC_API_KEY;
    registerBuiltInProviders(registry);
    expect(() => registry.createModel('anthropic', 'claude-3'))
      .toThrow('ANTHROPIC_API_KEY environment variable is not set');
  });
});

describe('createDefaultProviderRegistry', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns a registry with openai and anthropic pre-registered', () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.has('openai')).toBe(true);
    expect(registry.has('anthropic')).toBe(true);
    expect(registry.listProviders()).toEqual(['openai', 'anthropic']);
  });
});
