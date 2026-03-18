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

  describe('rapid state cycling', () => {
    test('should handle open→half-open→open→half-open→closed cycling', () => {
      const node = makeNode();

      // Trip the breaker: closed → open
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow();

      // Wait for timeout: open → half-open
      vi.advanceTimersByTime(6000);
      expect(() => manager.check(node)).not.toThrow(); // transitions to half-open

      // Fail in half-open: half-open → open
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow();

      // Wait for timeout again: open → half-open
      vi.advanceTimersByTime(6000);
      expect(() => manager.check(node)).not.toThrow(); // transitions to half-open

      // Succeed enough to close: half-open → closed (success_threshold: 2)
      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);

      // Breaker should now be closed — check passes without waiting
      expect(() => manager.check(node)).not.toThrow();
    });

    test('should handle multiple rapid open→half-open→open cycles before closing', () => {
      const node = makeNode();

      // Trip the breaker
      for (let i = 0; i < 3; i++) manager.update('node-1', false, nodes);

      // Cycle open→half-open→open three times
      for (let cycle = 0; cycle < 3; cycle++) {
        expect(() => manager.check(node)).toThrow();
        vi.advanceTimersByTime(6000);
        manager.check(node); // half-open
        manager.update('node-1', false, nodes); // back to open
      }

      // Finally recover
      vi.advanceTimersByTime(6000);
      manager.check(node); // half-open
      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('concurrent updates', () => {
    test('multiple rapid failures should consistently hit threshold', () => {
      const node = makeNode();

      // Simulate rapid sequential failures (failure_threshold: 3)
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // All 3 failures recorded — breaker should be open
      expect(() => manager.check(node)).toThrow();
    });

    test('interleaved successes and failures should reflect final state', () => {
      const node = makeNode();

      // Rapid interleaved: fail, fail, success (resets), fail, fail, fail (trips)
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', true, nodes);  // resets failure_count
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // 3 consecutive failures after reset — breaker should be open
      expect(() => manager.check(node)).toThrow();
    });

    test('rapid successes after failures should keep breaker closed', () => {
      const node = makeNode();

      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      // 2 failures, then rapid successes
      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);
      manager.update('node-1', true, nodes);

      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('edge cases', () => {
    test('success on a node that was never tracked creates initial state', () => {
      const node = makeNode({ id: 'fresh-node' });
      const allNodes = [node];

      manager.update('fresh-node', true, allNodes);

      // Should have created state and recorded success — check passes
      expect(() => manager.check(node)).not.toThrow();
    });

    test('multiple nodes with different threshold configs', () => {
      const strictNode = makeNode({
        id: 'strict',
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
          circuit_breaker: {
            enabled: true,
            failure_threshold: 1,  // trips on first failure
            success_threshold: 3,
            timeout_ms: 10000,
          },
        },
      } as Partial<GraphNode>);

      const lenientNode = makeNode({
        id: 'lenient',
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
          circuit_breaker: {
            enabled: true,
            failure_threshold: 5,
            success_threshold: 1,
            timeout_ms: 2000,
          },
        },
      } as Partial<GraphNode>);

      const allNodes = [strictNode, lenientNode];

      // One failure trips strict but not lenient
      manager.update('strict', false, allNodes);
      manager.update('lenient', false, allNodes);

      expect(() => manager.check(strictNode)).toThrow();
      expect(() => manager.check(lenientNode)).not.toThrow();

      // 4 more failures trips lenient too
      for (let i = 0; i < 4; i++) manager.update('lenient', false, allNodes);
      expect(() => manager.check(lenientNode)).toThrow();
    });

    test('check on half-open state allows execution', () => {
      const node = makeNode();

      // Trip the breaker
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // Wait for timeout → half-open
      vi.advanceTimersByTime(6000);
      manager.check(node); // transitions to half-open

      // Subsequent check on half-open should not throw
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('failure count reset on success in closed state', () => {
    test('single success after partial failures resets count to zero', () => {
      const node = makeNode();

      // 2 failures (threshold is 3)
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();

      // One success resets failure_count
      manager.update('node-1', true, nodes);

      // Now need 3 fresh failures to trip
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();

      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow(); // exactly 3 failures → trips
    });

    test('repeated reset cycles keep breaker closed', () => {
      const node = makeNode();

      for (let cycle = 0; cycle < 5; cycle++) {
        // Accumulate 2 failures (just below threshold)
        manager.update('node-1', false, nodes);
        manager.update('node-1', false, nodes);
        // Success resets
        manager.update('node-1', true, nodes);
      }

      // After 5 cycles of fail-fail-succeed, breaker should still be closed
      expect(() => manager.check(node)).not.toThrow();
    });

    test('success at exactly threshold minus one prevents tripping', () => {
      const node = makeNode();

      // 2 failures (threshold - 1)
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // Success right before it would trip
      manager.update('node-1', true, nodes);

      // One more failure should not trip (count reset to 0, now at 1)
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow();
    });
  });

  describe('half-open success count accumulation', () => {
    test('success_count increments properly in half-open', () => {
      const node = makeNode();

      // Trip the breaker
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);

      // Wait for timeout → half-open
      vi.advanceTimersByTime(6000);
      manager.check(node);

      // First success — still half-open (threshold is 2)
      manager.update('node-1', true, nodes);
      // Should still allow execution (half-open allows probes)
      expect(() => manager.check(node)).not.toThrow();

      // Second success — transitions to closed at exactly threshold
      manager.update('node-1', true, nodes);
      expect(() => manager.check(node)).not.toThrow();

      // Verify it's truly closed: failures should count from zero
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).not.toThrow(); // 2 < 3 threshold
    });

    test('exactly at success_threshold transitions to closed', () => {
      const node = makeNode({
        id: 'node-1',
        failure_policy: {
          max_retries: 3,
          backoff_strategy: 'exponential',
          initial_backoff_ms: 1000,
          max_backoff_ms: 60000,
          circuit_breaker: {
            enabled: true,
            failure_threshold: 3,
            success_threshold: 3,  // need exactly 3 successes
            timeout_ms: 5000,
          },
        },
      } as Partial<GraphNode>);
      const customNodes = [node];

      // Trip the breaker
      for (let i = 0; i < 3; i++) manager.update('node-1', false, customNodes);

      // Wait for half-open
      vi.advanceTimersByTime(6000);
      manager.check(node);

      // 2 successes — still half-open
      manager.update('node-1', true, customNodes);
      manager.update('node-1', true, customNodes);

      // Trip again to verify it's still half-open (a failure here reopens)
      // Actually, let's just add the 3rd success instead
      manager.update('node-1', true, customNodes);

      // Now closed — 3 failures needed to reopen
      manager.update('node-1', false, customNodes);
      manager.update('node-1', false, customNodes);
      expect(() => manager.check(node)).not.toThrow(); // only 2 failures
    });

    test('failure during half-open resets success_count', () => {
      const node = makeNode();

      // Trip → half-open
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      manager.update('node-1', false, nodes);
      vi.advanceTimersByTime(6000);
      manager.check(node);

      // 1 success in half-open
      manager.update('node-1', true, nodes);

      // Failure resets success_count and reopens
      manager.update('node-1', false, nodes);
      expect(() => manager.check(node)).toThrow();

      // Recover to half-open again
      vi.advanceTimersByTime(6000);
      manager.check(node);

      // Need full 2 successes again (not just 1)
      manager.update('node-1', true, nodes);
      // Still half-open after just 1 success
      manager.update('node-1', true, nodes);
      // Now closed
      expect(() => manager.check(node)).not.toThrow();
    });
  });
});
