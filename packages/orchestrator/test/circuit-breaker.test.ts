import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreakerManager } from '../src/runner/circuit-breaker.js';
import type { GraphNode } from '../src/types/graph.js';

vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'node-1',
    type: 'agent',
    read_keys: ['*'],
    write_keys: [],
    failure_policy: {
      max_retries: 3,
      backoff_strategy: 'exponential',
      initial_backoff_ms: 1000,
      max_backoff_ms: 60000,
      circuit_breaker: {
        enabled: true,
        failure_threshold: 3,
        success_threshold: 2,
        timeout_ms: 5000,
      },
    },
    requires_compensation: false,
    ...overrides,
  } as GraphNode;
}

describe('CircuitBreakerManager', () => {
  let manager: CircuitBreakerManager;
  const nodes = [makeNode()];

  beforeEach(() => {
    manager = new CircuitBreakerManager();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    test('check should pass for unknown node (no state yet)', () => {
      expect(() => manager.check(makeNode())).not.toThrow();
    });

    test('update creates initial closed state', () => {
      manager.update('node-1', true, nodes);
      // Subsequent check should pass (closed breaker)
      expect(() => manager.check(makeNode())).not.toThrow();
    });
  });

  describe('closed -> open transition', () => {
    test('should open after reaching failure threshold', () => {
      const node = makeNode();

      // 3 failures to hit threshold (configured failure_threshold: 3)
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow(); // Still closed after 2

      manager.update('node-1', false, nodes);
      // Now open — check should throw
      expect(() => manager.check(node)).toThrow('Circuit breaker open for node node-1');
    });

    test('should use default threshold of 5 when not configured', () => {
      const node = makeNode({
        failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      } as Partial<GraphNode>);
      const nodesDefault = [node];

      for (let i = 0; i < 4; i++) {
        manager.update('node-1', false, nodesDefault);
      }
      expect(() => manager.check(node)).not.toThrow(); // 4 failures, default threshold is 5

      manager.update('node-1', false, nodesDefault);
      expect(() => manager.check(node)).toThrow(); // 5th failure opens it
    });

    test('successes should reset failure count', () => {
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      // 2 failures, then a success resets
      manager.update('node-1', true, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // Only 2 failures since reset, threshold is 3
      expect(() => manager.check(makeNode())).not.toThrow();
    });
  });

  describe('open -> half-open transition (timeout)', () => {
    test('should stay open before timeout elapses', () => {
      const node = makeNode();

      // Trip the breaker
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // Advance time but less than timeout (5000ms)
      vi.advanceTimersByTime(3000);
      expect(() => manager.check(node)).toThrow();
    });

    test('should transition to half-open after timeout', () => {
      const node = makeNode();

      // Trip the breaker
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // Advance past timeout
      vi.advanceTimersByTime(6000);
      // check() should NOT throw — it transitions to half-open
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('half-open -> closed transition', () => {
    test('should close after success threshold in half-open', () => {
      const node = makeNode();

      // Trip the breaker
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // Wait for timeout to transition to half-open
      vi.advanceTimersByTime(6000);
      manager.check(node); // transitions to half-open

      // success_threshold is 2
      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);

      // Should be closed now — subsequent checks pass even without timeout
      vi.advanceTimersByTime(0);
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('half-open -> open transition (failure during half-open)', () => {
    test('should reopen immediately on failure in half-open', () => {
      const node = makeNode();

      // Trip the breaker
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // Wait for half-open
      vi.advanceTimersByTime(6000);
      manager.check(node); // transitions to half-open

      // Fail during half-open
      manager.update('node-1', false, nodes);

      // Should be open again — need to wait for timeout
      expect(() => manager.check(node)).toThrow();
    });
  });

  describe('multiple nodes', () => {
    test('should track each node independently', () => {
      const node1 = makeNode({ id: 'node-1' });
      const node2 = makeNode({ id: 'node-2' });
      const allNodes = [node1, node2];

      // Trip node-1
      manager.update('node-1', false, allNodes);
      manager.update('node-1', false, allNodes);
      manager.update('node-1', false, allNodes);

      expect(() => manager.check(node1)).toThrow();
      expect(() => manager.check(node2)).not.toThrow(); // node-2 unaffected
    });
  });

  describe('default timeout', () => {
    test('should use 60000ms default when timeout_ms not configured', () => {
      const node = makeNode({
        failure_policy: { max_retries: 3, backoff_strategy: 'exponential', initial_backoff_ms: 1000, max_backoff_ms: 60000 },
      } as Partial<GraphNode>);
      const nodesDefault = [node];

      // Trip with 5 failures (default threshold)
      for (let i = 0; i < 5; i++) {
        manager.update('node-1', false, nodesDefault);
      }

      // Still open at 59s
      vi.advanceTimersByTime(59000);
      expect(() => manager.check(node)).toThrow();

      // Opens at 60s
      vi.advanceTimersByTime(2000);
      expect(() => manager.check(node)).not.toThrow();
    });
  });
});
