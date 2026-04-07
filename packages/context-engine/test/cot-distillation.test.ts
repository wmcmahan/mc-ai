import { describe, it, expect } from 'vitest';
import { distillCoT, createCotDistillationStage, DEFAULT_DELIMITERS } from '../src/pruning/cot-distillation.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

const counter = new DefaultTokenCounter();

describe('distillCoT', () => {
  it('removes <think> blocks and preserves conclusion', () => {
    const content = 'Start. <think>Long reasoning about the problem. Let me consider options. Therefore: The answer is 42.</think> End.';
    const result = distillCoT(content);
    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('[Reasoning distilled]');
    expect(result.distilled).toContain('The answer is 42.');
    expect(result.distilled).not.toContain('Long reasoning');
    expect(result.distilled).toContain('Start.');
    expect(result.distilled).toContain('End.');
  });

  it('removes <reasoning> blocks', () => {
    const content = 'Before <reasoning>Step 1. Step 2. In conclusion: Use method B.</reasoning> After';
    const result = distillCoT(content);
    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('Use method B');
    expect(result.distilled).not.toContain('Step 1');
  });

  it('removes <scratchpad> blocks', () => {
    const content = 'Result: <scratchpad>Working through calculations...</scratchpad> Done.';
    const result = distillCoT(content);
    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('Done.');
  });

  it('removes <antThinking> blocks', () => {
    const content = '<antThinking>Internal deliberation. The answer is: Paris.</antThinking>The capital is Paris.';
    const result = distillCoT(content);
    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('Paris');
  });

  it('removes <thought> blocks', () => {
    const content = '<thought>Let me think about this carefully. Thus: Option A is best.</thought>I recommend Option A.';
    const result = distillCoT(content);
    expect(result.tracesRemoved).toBe(1);
    expect(result.distilled).toContain('Option A');
  });

  it('handles multiple blocks in one string', () => {
    const content = '<think>Reasoning 1. Therefore: A.</think> Middle. <think>Reasoning 2. Therefore: B.</think> End.';
    const result = distillCoT(content);
    expect(result.tracesRemoved).toBe(2);
    expect(result.distilled).toContain('A.');
    expect(result.distilled).toContain('B.');
    expect(result.distilled).toContain('Middle.');
  });

  it('skips unclosed delimiters without corruption', () => {
    const content = 'Before <think>unclosed reasoning without end tag. After.';
    const result = distillCoT(content);
    expect(result.tracesRemoved).toBe(0);
    expect(result.distilled).toBe(content); // unchanged
  });

  it('uses [Reasoning trace removed] when no conclusion found', () => {
    const content = '<think>A</think>';
    const result = distillCoT(content);
    expect(result.distilled).toContain('[Reasoning trace removed]');
  });

  it('extracts last paragraph as conclusion fallback', () => {
    const content = '<think>First paragraph of reasoning.\n\nSecond paragraph of reasoning.\n\nFinal conclusion paragraph.</think>';
    const result = distillCoT(content);
    expect(result.distilled).toContain('Final conclusion paragraph');
  });

  it('filters delimiters by model family', () => {
    const content = '<think>DeepSeek reasoning. Therefore: X.</think> <antThinking>Anthropic thinking.</antThinking>';
    // With deepseek model, should only process <think>
    const result = distillCoT(content, {}, 'deepseek-v3');
    expect(result.tracesRemoved).toBe(1); // only <think>
    expect(result.distilled).toContain('<antThinking>'); // left intact
  });

  it('always processes generic delimiters regardless of model', () => {
    const content = '<reasoning>Generic trace. In conclusion: Done.</reasoning>';
    const result = distillCoT(content, {}, 'deepseek-v3');
    expect(result.tracesRemoved).toBe(1); // generic always processed
  });

  it('processes all delimiters when model is unknown', () => {
    const content = '<think>A. Therefore: X.</think> <antThinking>B. Therefore: Y.</antThinking>';
    const result = distillCoT(content, {}, 'some-unknown-model');
    expect(result.tracesRemoved).toBe(2); // all delimiters checked
  });

  it('supports preserveConclusion: false', () => {
    const content = '<think>Long reasoning. Therefore: The answer.</think>';
    const result = distillCoT(content, { preserveConclusion: false });
    expect(result.distilled).toBe('[Reasoning trace removed]');
    expect(result.distilled).not.toContain('The answer');
  });

  it('reports tokens evicted', () => {
    const longReasoning = 'x '.repeat(200);
    const content = `<think>${longReasoning}Therefore: Answer.</think>`;
    const result = distillCoT(content);
    expect(result.tokensEvicted).toBeGreaterThan(50);
  });

  it('uses custom charsPerToken ratio for token eviction estimate', () => {
    const longReasoning = 'x '.repeat(200);
    const content = `<think>${longReasoning}Therefore: Answer.</think>`;
    const defaultResult = distillCoT(content);
    const customResult = distillCoT(content, { charsPerToken: 2 });
    // With charsPerToken=2 (fewer chars per token), we get more tokens evicted
    expect(customResult.tokensEvicted).toBeGreaterThan(defaultResult.tokensEvicted);
  });

  it('preserves default charsPerToken ratio of 4 when option omitted', () => {
    const longReasoning = 'x '.repeat(200);
    const content = `<think>${longReasoning}Therefore: Answer.</think>`;
    const defaultResult = distillCoT(content);
    const explicitResult = distillCoT(content, { charsPerToken: 4 });
    expect(defaultResult.tokensEvicted).toBe(explicitResult.tokensEvicted);
  });

  it('handles nested delimiters by processing outermost', () => {
    const content = '<think>Outer reasoning <think>inner nested</think> still outer. Therefore: Result.</think>';
    const result = distillCoT(content);
    // Should process the first open/close pair (outermost)
    expect(result.tracesRemoved).toBeGreaterThanOrEqual(1);
    expect(result.distilled).not.toContain('Outer reasoning');
  });

  it('returns unchanged content when no reasoning blocks found', () => {
    const content = 'Just a regular response with no reasoning blocks.';
    const result = distillCoT(content);
    expect(result.tracesRemoved).toBe(0);
    expect(result.distilled).toBe(content);
  });
});

describe('createCotDistillationStage', () => {
  it('distills reasoning in pipeline segments', () => {
    const stage = createCotDistillationStage();
    const content = 'Answer: <think>Long thinking process. Lots of reasoning here. Therefore: 42.</think> The result is 42.';
    const segments: PromptSegment[] = [
      { id: 'a', content, role: 'memory', priority: 1, locked: false },
    ];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).not.toContain('Long thinking process');
    expect(result.segments[0].content).toContain('42');
  });

  it('passes through segments without reasoning blocks', () => {
    const stage = createCotDistillationStage();
    const content = 'No reasoning here.';
    const segments: PromptSegment[] = [
      { id: 'a', content, role: 'memory', priority: 1, locked: false },
    ];
    const context = {
      tokenCounter: counter,
      budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
    };

    const result = stage.execute(segments, context);
    expect(result.segments[0].content).toBe(content);
  });

  it('has name cot-distillation', () => {
    const stage = createCotDistillationStage();
    expect(stage.name).toBe('cot-distillation');
  });
});

describe('DEFAULT_DELIMITERS', () => {
  it('covers all major model families', () => {
    const families = new Set(DEFAULT_DELIMITERS.map(d => d.family));
    expect(families.has('deepseek')).toBe(true);
    expect(families.has('anthropic')).toBe(true);
    expect(families.has('openai')).toBe(true);
    expect(families.has('generic')).toBe(true);
  });
});
