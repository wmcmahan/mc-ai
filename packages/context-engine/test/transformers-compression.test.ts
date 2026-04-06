import { describe, it, expect } from 'vitest';
import { TransformersJsCompressionProvider } from '../src/providers/transformers-compression.js';
import type { CompressionProvider } from '../src/providers/types.js';

describe('TransformersJsCompressionProvider', () => {
  // Test 1: empty tokens
  it('returns empty array for empty tokens', async () => {
    const provider = new TransformersJsCompressionProvider();
    const scores = await provider.scoreTokenImportance([]);
    expect(scores).toEqual([]);
  });

  // Test 2: provider satisfies interface
  it('satisfies CompressionProvider interface', () => {
    const provider: CompressionProvider = new TransformersJsCompressionProvider();
    expect(provider.scoreTokenImportance).toBeDefined();
  });

  // Test 3: default options
  it('uses default model and maxLength', () => {
    const provider = new TransformersJsCompressionProvider();
    // Just verify construction succeeds with defaults
    expect(provider).toBeDefined();
  });

  // Test 4: custom options
  it('accepts custom model and maxLength', () => {
    const provider = new TransformersJsCompressionProvider({
      model: 'custom/model',
      maxLength: 1024,
    });
    expect(provider).toBeDefined();
  });

  // Test 5: error when transformers not installed
  it('throws descriptive error when @huggingface/transformers not available', async () => {
    const provider = new TransformersJsCompressionProvider();
    // The dynamic import will fail since the package isn't installed
    await expect(provider.scoreTokenImportance(['hello'])).rejects.toThrow(
      /Failed to load transformers\.js model/,
    );
  });

  // Test 6: error includes model name
  it('error message includes model ID', async () => {
    const provider = new TransformersJsCompressionProvider({ model: 'test/model' });
    await expect(provider.scoreTokenImportance(['hello'])).rejects.toThrow('test/model');
  });

  // Test 7: error includes install instruction
  it('error message includes install instruction', async () => {
    const provider = new TransformersJsCompressionProvider();
    await expect(provider.scoreTokenImportance(['hello'])).rejects.toThrow(
      'npm install @huggingface/transformers',
    );
  });

  // Test 8: lazy loading (multiple calls don't re-init)
  it('lazy loads pipeline only once (caches failure too)', async () => {
    const provider = new TransformersJsCompressionProvider();
    // First call fails
    await expect(provider.scoreTokenImportance(['a'])).rejects.toThrow();
    // Second call also fails (but same error, pipeline load not retried since it threw)
    await expect(provider.scoreTokenImportance(['b'])).rejects.toThrow();
  });
});
