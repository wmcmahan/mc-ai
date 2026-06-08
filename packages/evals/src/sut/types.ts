/**
 * SUT (System-Under-Test) Types
 *
 * Shared types for the recording layer that captures real output and
 * tool calls from the packages under evaluation. Used by recording
 * scripts to ground golden trajectories in observable behavior.
 *
 * @module sut/types
 */

import type { ToolCall } from '../dataset/types.js';

/** A tool call observed during a SUT run. */
export interface RecordedToolCall extends ToolCall {
  /** Node ID that emitted the call. */
  nodeId: string;
  /** Unique tool call identifier from the runner. */
  callId: string;
  /** Monotonic ordering index within the run. */
  order: number;
}

/** Terminal status of a SUT run. */
export type SutStatus = 'completed' | 'failed' | 'timeout';

/** Outcome of a single SUT execution. */
export interface SutRunResult {
  /** The primary textual output extracted from the SUT (e.g., the final draft, summary, or response). */
  output: string;
  /** Tool calls observed during the run, in invocation order. */
  toolCalls: RecordedToolCall[];
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Final state memory (or relevant subset) for debugging and assertion. */
  finalMemory: Record<string, unknown>;
  /** Terminal status. */
  status: SutStatus;
  /** Error message when status is 'failed' or 'timeout'. */
  error?: string;
}

/**
 * Canned tool response factory: given the args passed by the LLM,
 * return a deterministic result. Used by the mock tool resolver during
 * recording so SUT runs are network-free apart from the LLM call itself.
 */
export type ToolResponseFn = (args: Record<string, unknown>) => unknown;

/** Map of tool name → canned response factory. */
export type ToolResponseMap = Record<string, ToolResponseFn>;
