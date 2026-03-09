import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTracer, withSpan } from '../src/utils/tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';

describe('getTracer', () => {
  it('returns a tracer object', () => {
    const tracer = getTracer('test.component');
    expect(tracer).toBeDefined();
    expect(typeof tracer.startActiveSpan).toBe('function');
  });

  it('returns a tracer even without OTel init (no-op tracer)', () => {
    const tracer = getTracer('uninitialized');
    expect(tracer).toBeDefined();
  });
});

describe('withSpan', () => {
  it('returns the function result on success', async () => {
    const tracer = getTracer('test');
    const result = await withSpan(tracer, 'test.operation', async (span) => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('propagates errors from the wrapped function', async () => {
    const tracer = getTracer('test');
    await expect(
      withSpan(tracer, 'test.failing', async () => {
        throw new Error('test failure');
      }),
    ).rejects.toThrow('test failure');
  });

  it('provides a span object to the callback', async () => {
    const tracer = getTracer('test');
    let receivedSpan: unknown = null;

    await withSpan(tracer, 'test.span', async (span) => {
      receivedSpan = span;
      return null;
    });

    expect(receivedSpan).toBeDefined();
  });

  it('works with async operations', async () => {
    const tracer = getTracer('test');
    const result = await withSpan(tracer, 'test.async', async () => {
      await new Promise(r => setTimeout(r, 5));
      return 'delayed';
    });
    expect(result).toBe('delayed');
  });

  it('accepts optional attributes', async () => {
    const tracer = getTracer('test');
    const result = await withSpan(
      tracer,
      'test.attrs',
      async () => 'ok',
      { 'custom.attr': 'value', 'custom.count': 5 },
    );
    expect(result).toBe('ok');
  });
});
