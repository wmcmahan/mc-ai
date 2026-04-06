import { describe, it, expect } from 'vitest';
import {
  parseJudgeResponse,
  evaluateMetric,
  evaluateSemantics,
  ANSWER_RELEVANCY,
  FAITHFULNESS,
  LOGICAL_COHERENCE,
  BUILT_IN_METRICS,
} from '../../src/assertions/semantic-judge.js';
import type { SemanticJudgeContext } from '../../src/assertions/semantic-judge.js';

describe('parseJudgeResponse', () => {
  it('parses clean JSON', () => {
    const result = parseJudgeResponse('{"score": 0.85, "reasoning": "Good match"}');

    expect(result.score).toBe(0.85);
    expect(result.reasoning).toBe('Good match');
  });

  it('parses JSON wrapped in markdown code block', () => {
    const raw = '```json\n{"score": 0.9, "reasoning": "Excellent"}\n```';
    const result = parseJudgeResponse(raw);

    expect(result.score).toBe(0.9);
    expect(result.reasoning).toBe('Excellent');
  });

  it('parses JSON with surrounding text', () => {
    const raw = 'Here is my evaluation:\n{"score": 0.7, "reasoning": "Partial match"}\nDone.';
    const result = parseJudgeResponse(raw);

    expect(result.score).toBe(0.7);
    expect(result.reasoning).toBe('Partial match');
  });

  it('clamps score to 0.0-1.0 range', () => {
    expect(parseJudgeResponse('{"score": 1.5, "reasoning": ""}').score).toBe(1.0);
    expect(parseJudgeResponse('{"score": -0.5, "reasoning": ""}').score).toBe(0.0);
  });

  it('returns score 0 for unparseable response', () => {
    const result = parseJudgeResponse('I cannot evaluate this.');

    expect(result.score).toBe(0);
    expect(result.reasoning).toContain('Failed to parse');
  });

  it('handles missing fields gracefully', () => {
    const result = parseJudgeResponse('{"score": 0.8}');

    expect(result.score).toBe(0.8);
    expect(result.reasoning).toBe('No reasoning provided');
  });
});

describe('evaluateMetric', () => {
  const context: SemanticJudgeContext = {
    input: 'Who is the CEO of Anthropic?',
    actualOutput: 'Dario Amodei is the CEO.',
    expectedOutput: 'Dario Amodei is the CEO of Anthropic.',
  };

  it('passes when judge scores above threshold', async () => {
    const callJudge = async () => '{"score": 0.95, "reasoning": "Accurate match"}';

    const result = await evaluateMetric(context, ANSWER_RELEVANCY, callJudge);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.95);
    expect(result.metric).toBe('answer_relevancy');
  });

  it('fails when judge scores below threshold', async () => {
    const callJudge = async () => '{"score": 0.6, "reasoning": "Partial answer"}';

    const result = await evaluateMetric(context, FAITHFULNESS, callJudge, 0.8);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.6);
    expect(result.metric).toBe('faithfulness');
  });

  it('respects custom threshold', async () => {
    const callJudge = async () => '{"score": 0.6, "reasoning": "OK"}';

    const result = await evaluateMetric(context, ANSWER_RELEVANCY, callJudge, 0.5);

    expect(result.passed).toBe(true);
  });
});

describe('evaluateSemantics', () => {
  const context: SemanticJudgeContext = {
    input: 'Test input',
    actualOutput: 'Test output',
    expectedOutput: 'Expected output',
  };

  it('runs all built-in metrics by default', async () => {
    const callJudge = async () => '{"score": 0.9, "reasoning": "Good"}';

    const results = await evaluateSemantics(context, callJudge);

    expect(results).toHaveLength(BUILT_IN_METRICS.length);
    expect(results.map(r => r.metric)).toEqual([
      'answer_relevancy',
      'faithfulness',
      'logical_coherence',
    ]);
  });

  it('runs only specified metrics', async () => {
    const callJudge = async () => '{"score": 0.9, "reasoning": "Good"}';

    const results = await evaluateSemantics(context, callJudge, {
      metrics: [LOGICAL_COHERENCE],
    });

    expect(results).toHaveLength(1);
    expect(results[0].metric).toBe('logical_coherence');
  });
});

describe('rubric prompts', () => {
  const context: SemanticJudgeContext = {
    input: 'test input',
    actualOutput: 'actual output',
    expectedOutput: 'expected output',
  };

  it('ANSWER_RELEVANCY includes input and both outputs', () => {
    const prompt = ANSWER_RELEVANCY.buildPrompt(context);

    expect(prompt).toContain('test input');
    expect(prompt).toContain('actual output');
    expect(prompt).toContain('expected output');
    expect(prompt).toContain('Score from 0.0 to 1.0');
  });

  it('FAITHFULNESS includes expected and actual outputs', () => {
    const prompt = FAITHFULNESS.buildPrompt(context);

    expect(prompt).toContain('actual output');
    expect(prompt).toContain('expected output');
    expect(prompt).toContain('factually consistent');
  });

  it('LOGICAL_COHERENCE includes input and actual output', () => {
    const prompt = LOGICAL_COHERENCE.buildPrompt(context);

    expect(prompt).toContain('test input');
    expect(prompt).toContain('actual output');
    expect(prompt).toContain('logically coherent');
  });
});
