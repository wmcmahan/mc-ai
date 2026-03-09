import { describe, test, expect, vi } from 'vitest';
import { calculateBackoff, sleep } from '../src/runner/helpers.js';

describe('Helper Utilities', () => {
  describe('calculateBackoff', () => {
    describe('linear strategy', () => {
      test('should increase linearly', () => {
        expect(calculateBackoff(1, 'linear', 1000, 10000)).toBe(1000);
        expect(calculateBackoff(2, 'linear', 1000, 10000)).toBe(2000);
        expect(calculateBackoff(3, 'linear', 1000, 10000)).toBe(3000);
        expect(calculateBackoff(4, 'linear', 1000, 10000)).toBe(4000);
      });

      test('should respect max backoff', () => {
        expect(calculateBackoff(20, 'linear', 1000, 10000)).toBe(10000);
      });
    });

    describe('exponential strategy', () => {
      test('should increase exponentially', () => {
        expect(calculateBackoff(1, 'exponential', 1000, 60000)).toBe(1000);  // 1000 * 2^0
        expect(calculateBackoff(2, 'exponential', 1000, 60000)).toBe(2000);  // 1000 * 2^1
        expect(calculateBackoff(3, 'exponential', 1000, 60000)).toBe(4000);  // 1000 * 2^2
        expect(calculateBackoff(4, 'exponential', 1000, 60000)).toBe(8000);  // 1000 * 2^3
        expect(calculateBackoff(5, 'exponential', 1000, 60000)).toBe(16000); // 1000 * 2^4
      });

      test('should respect max backoff', () => {
        expect(calculateBackoff(10, 'exponential', 1000, 60000)).toBe(60000);
      });

      test('should handle large attempt numbers', () => {
        // 1000 * 2^99 would overflow, should cap at max
        expect(calculateBackoff(100, 'exponential', 1000, 60000)).toBe(60000);
      });
    });

    describe('fixed strategy', () => {
      test('should always return initial backoff', () => {
        expect(calculateBackoff(1, 'fixed', 5000, 60000)).toBe(5000);
        expect(calculateBackoff(2, 'fixed', 5000, 60000)).toBe(5000);
        expect(calculateBackoff(10, 'fixed', 5000, 60000)).toBe(5000);
        expect(calculateBackoff(100, 'fixed', 5000, 60000)).toBe(5000);
      });

      test('should respect max backoff', () => {
        expect(calculateBackoff(1, 'fixed', 70000, 60000)).toBe(60000);
      });
    });

    describe('edge cases', () => {
      test('should handle zero initial backoff', () => {
        expect(calculateBackoff(1, 'linear', 0, 10000)).toBe(0);
        expect(calculateBackoff(1, 'exponential', 0, 10000)).toBe(0);
        expect(calculateBackoff(1, 'fixed', 0, 10000)).toBe(0);
      });

      test('should handle zero max backoff', () => {
        expect(calculateBackoff(1, 'linear', 1000, 0)).toBe(0);
        expect(calculateBackoff(1, 'exponential', 1000, 0)).toBe(0);
      });

      test('should handle attempt 0', () => {
        // Edge case: 2^-1 = 0.5, so 1000 * 0.5 = 500
        expect(calculateBackoff(0, 'exponential', 1000, 60000)).toBe(500);
      });
    });
  });

  describe('sleep', () => {
    test('should resolve after specified time', async () => {
      const start = Date.now();
      await sleep(100);
      const elapsed = Date.now() - start;

      // Allow 50ms tolerance
      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(150);
    });

    test('should handle zero delay', async () => {
      const start = Date.now();
      await sleep(0);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10);
    });

    test('should be awaitable', async () => {
      let completed = false;

      sleep(50).then(() => {
        completed = true;
      });

      expect(completed).toBe(false);
      await sleep(60);
      expect(completed).toBe(true);
    });
  });
});
