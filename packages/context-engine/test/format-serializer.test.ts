import { describe, it, expect } from 'vitest';
import { serialize, createFormatStage } from '../src/format/serializer.js';
import type { PromptSegment, BudgetConfig } from '../src/pipeline/types.js';
import { DefaultTokenCounter } from '../src/providers/defaults.js';

describe('serialize', () => {
  it('auto-detects tabular data', () => {
    const data = [
      { name: 'Alice', score: 92 },
      { name: 'Bob', score: 87 },
    ];
    const result = serialize(data);
    expect(result).toContain('@name');
    expect(result).toContain('Alice');
  });

  it('auto-detects flat object', () => {
    const result = serialize({ name: 'Alice', age: 30 });
    expect(result).toBe('name: Alice\nage: 30');
  });

  it('auto-detects nested object', () => {
    const result = serialize({ user: { name: 'Alice' } });
    expect(result).toContain('user:');
    expect(result).toContain('  name: Alice');
  });

  it('handles primitives', () => {
    expect(serialize('hello')).toBe('hello');
    expect(serialize(42)).toBe('42');
    expect(serialize(null)).toBe('_');
  });

  it('respects forceShape override', () => {
    // Force nested on a flat object
    const result = serialize({ name: 'Alice', age: 30 }, { forceShape: 'nested' });
    expect(result).toBe('name: Alice\nage: 30');
  });
});

describe('createFormatStage', () => {
  const counter = new DefaultTokenCounter();
  const context = {
    tokenCounter: counter,
    budget: { maxTokens: 4096, outputReserve: 0 } as BudgetConfig,
  };

  function makeSegment(id: string, content: string): PromptSegment {
    return { id, content, role: 'memory', priority: 1, locked: false };
  }

  it('compresses JSON content in segments', () => {
    const stage = createFormatStage();
    const json = JSON.stringify([
      { name: 'Alice', role: 'researcher', score: 92 },
      { name: 'Bob', role: 'writer', score: 87 },
    ], null, 2);

    const result = stage.execute([makeSegment('mem', json)], context);
    expect(result.segments[0].content).toContain('@name');
    expect(result.segments[0].content.length).toBeLessThan(json.length);
  });

  it('passes through non-JSON content unchanged', () => {
    const stage = createFormatStage();
    const text = 'This is a plain text system prompt.';
    const result = stage.execute([makeSegment('sys', text)], context);
    expect(result.segments[0].content).toBe(text);
  });

  it('handles multiple segments independently', () => {
    const stage = createFormatStage();
    const jsonSeg = makeSegment('json', JSON.stringify({ a: 1, b: 2 }));
    const textSeg = makeSegment('text', 'plain text');

    const result = stage.execute([jsonSeg, textSeg], context);
    expect(result.segments[0].content).toContain('a: 1');
    expect(result.segments[1].content).toBe('plain text');
  });

  it('achieves measurable token reduction on JSON', () => {
    const stage = createFormatStage();
    const data = {
      supervisor_history: [
        { supervisor_id: 'sup-1', delegated_to: 'research', reasoning: 'Need research first', iteration: 1 },
        { supervisor_id: 'sup-1', delegated_to: 'writer', reasoning: 'Research complete, write now', iteration: 2 },
      ],
      research_results: { topic: 'AI Safety', findings: 'Key findings about alignment' },
      agent_config: { model: 'claude-sonnet', temperature: 0.7, maxSteps: 10 },
    };

    const json = JSON.stringify(data, null, 2);
    const result = stage.execute([makeSegment('mem', json)], context);

    const tokensBefore = counter.countTokens(json);
    const tokensAfter = counter.countTokens(result.segments[0].content);
    const reduction = ((tokensBefore - tokensAfter) / tokensBefore) * 100;

    expect(reduction).toBeGreaterThan(20); // Expect at least 20% reduction
  });
});
