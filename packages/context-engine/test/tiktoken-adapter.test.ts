import { describe, it, expect } from 'vitest';
import { createTiktokenCounter } from '../src/providers/tiktoken-adapter.js';

describe('createTiktokenCounter', () => {
  // Mock encode function that splits on spaces (1 token per word)
  const mockEncode = (text: string): number[] =>
    text.split(/\s+/).filter(w => w.length > 0).map((_, i) => i);

  it('counts tokens using the encode function', () => {
    const counter = createTiktokenCounter(mockEncode);
    expect(counter.countTokens('hello world foo')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    const counter = createTiktokenCounter(mockEncode);
    expect(counter.countTokens('')).toBe(0);
  });

  it('works with pipeline stages', () => {
    const counter = createTiktokenCounter(mockEncode);
    // Verify it satisfies the TokenCounter interface
    expect(typeof counter.countTokens).toBe('function');
    expect(counter.countTokens('one two three four five')).toBe(5);
  });
});
