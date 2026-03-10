/**
 * Agent Executor
 *
 * Orchestrates a single LLM agent invocation end-to-end:
 *
 * 1. Load agent config from factory (cached)
 * 2. Build context-aware system prompt (with injection guards)
 * 3. Execute agent with tools via `streamText` (with timeout)
 * 4. Track token usage
 * 5. Extract memory updates from `save_to_memory` tool calls
 * 6. Propagate taint metadata for derived outputs
 * 7. Validate Zero Trust permissions
 * 8. Return an {@link Action} for the GraphRunner
 *
 * Security hardening:
 * - Prompt injection guards via sanitization + `<data>` boundaries
 * - Internal metadata separated from agent memory
 * - AbortController with configurable timeout
 * - Bounded memory serialisation in prompts
 * - Tool call/result correlation by ID (not index)
 * - Zero Trust permission validation
 *
 * @module agent-executor/executor
 */

import { streamText, tool, stepCountIs, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import { agentFactory } from '../agent-factory/index.js';
import type { StateView, Action } from '../../types/state.js';
import { createLogger } from '../../utils/logger.js';
import { getTracer, withSpan } from '../../utils/tracing.js';
import { v4 as uuidv4 } from 'uuid';
import { getTaintRegistry, propagateDerivedTaint } from '../../utils/taint.js';
import { buildSystemPrompt, buildTaskPrompt } from './prompts.js';
import { DEFAULT_AGENT_TIMEOUT_MS } from '../constants.js';
import { extractMemoryUpdates } from './memory.js';
import { validateMemoryUpdatePermissions } from './validation.js';
import { AgentTimeoutError, AgentExecutionError } from './errors.js';

const logger = createLogger('agent.executor');
const tracer = getTracer('orchestrator.agent');

/** Token usage from a single agent execution. */
export interface TokenUsage {
  /** The number of input tokens consumed. */
  inputTokens: number;
  /** The number of output tokens generated. */
  outputTokens: number;
  /** The total number of tokens (input + output). */
  totalTokens: number;
}


/**
 * Minimal shape of a single step returned by `streamText().steps`.
 *
 * The AI SDK's `StepResult<ToolSet>` generic has complex conditional types
 * that don't narrow cleanly when tools are dynamic, so we define the subset
 * we actually access.
 */
interface AgentStep {
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args?: unknown;
    input?: unknown;
  }>;
  toolResults?: Array<{
    toolCallId?: string;
    result?: unknown;
  }>;
}

/**
 * Execute a single agent invocation against the LLM.
 *
 * @param agent_id - The database ID of the agent to execute.
 * @param stateView - The current workflow state, scoped to this agent's read permissions.
 * @param rawTools - Tool definitions to expose to the LLM.
 * @param attempt - The current attempt number (1-based, increments on retry).
 * @param options - Optional execution configuration.
 * @param options.temperature_override - Override the agent's configured temperature.
 * @param options.node_id - The graph node ID, used to derive the fallback memory key.
 * @param options.timeout_ms - Override the default agent timeout.
 * @param options.abortSignal - External cancellation signal (e.g. workflow cancellation).
 * @param options.onToken - Callback invoked for each streamed token (best-effort).
 * @returns The resulting {@link Action} containing memory updates and metadata.
 * @throws {AgentTimeoutError} If the LLM call exceeds the configured timeout.
 * @throws {AgentExecutionError} If the LLM call fails for any other reason.
 */
export async function executeAgent(
  agent_id: string,
  stateView: StateView,
  rawTools: Record<string, unknown>,
  attempt: number,
  options?: {
    temperature_override?: number;
    node_id?: string;
    timeout_ms?: number;
    abortSignal?: AbortSignal;
    onToken?: (token: string) => void;
  }
): Promise<Action> {
  return withSpan(tracer, 'agent.execute', async (span) => {
    span.setAttribute('agent.id', agent_id);
    span.setAttribute('agent.attempt', attempt);

    const startTime = Date.now();

    // Load agent config from database (cached)
    const config = await agentFactory.loadAgent(agent_id);
    const model = agentFactory.getModel(config);

    // Build context-aware prompt (with injection guards)
    const systemPrompt = buildSystemPrompt(config, stateView);
    const taskPrompt = buildTaskPrompt(stateView, attempt);

    // Wrap resolved tools into AI SDK v6 tool() format
    const tools = buildToolSet(rawTools, agent_id);

    logger.info('executing', {
      agent_id,
      agent_name: config.name,
      model: config.model,
      attempt,
      tool_count: Object.keys(tools).length,
    });

    // AbortController with configurable timeout to prevent hung LLM calls.
    // If an external abort signal is provided (workflow cancellation), combine
    // it with the internal timeout so either can abort the stream.
    const timeoutMs = options?.timeout_ms ?? DEFAULT_AGENT_TIMEOUT_MS;
    const { timeoutId, controller } = createAbortControllerWithTimeout(timeoutMs);

    // Combine external cancellation signal with internal timeout
    const combinedSignal = options?.abortSignal
      ? AbortSignal.any([controller.signal, options.abortSignal])
      : controller.signal;

    let text: string;
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    let steps: AgentStep[];

    try {
      // Execute agent with streaming
      // stopWhen enables multi-step tool use: LLM generates text, calls tools,
      // sees results, and can call more tools — critical for save_to_memory
      const result = await streamText({
        model,
        system: systemPrompt,
        prompt: taskPrompt,
        tools,
        stopWhen: stepCountIs(config.maxSteps),
        abortSignal: combinedSignal,
        ...(options?.temperature_override !== undefined ? { temperature: options.temperature_override } : {}),
      });

      // When onToken is provided, consume the textStream for token-by-token
      // streaming. Otherwise use the existing await path (zero overhead).
      if (options?.onToken) {
        text = '';
        for await (const delta of result.textStream) {
          text += delta;
          try { options.onToken(delta); } catch { /* best-effort streaming */ }
        }
      } else {
        text = await result.text;
      }

      // Track token usage
      usage = await result.usage;

      // Extract tool calls and results from ALL steps.
      // result.toolCalls only contains the LAST step's calls, so save_to_memory
      // calls from earlier steps would be lost. Use result.steps instead.
      steps = ((await result.steps) ?? []) as AgentStep[];
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const duration = Date.now() - startTime;
        logger.error('agent_timeout', error, {
          agent_id,
          timeout_ms: timeoutMs,
          duration_ms: duration,
        });
        span.setAttribute('agent.error', 'timeout');
        throw new AgentTimeoutError(agent_id, timeoutMs);
      }

      // Structured error handling — log and re-wrap
      const duration = Date.now() - startTime;
      logger.error('agent_execution_failed', error, {
        agent_id,
        model: config.model,
        attempt,
        duration_ms: duration,
      });
      span.setAttribute('agent.error', error instanceof Error ? error.message : String(error));
      throw new AgentExecutionError(agent_id, error);
    } finally {
      clearTimeout(timeoutId);
    }

    const tokenUsage: TokenUsage = {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
    };

    // Flatten tool calls and results from all steps
    const toolCalls = steps.flatMap((step) => step.toolCalls ?? []);
    const toolResults = steps.flatMap((step) => step.toolResults ?? []);

    // Log individual tool calls for observability
    for (const call of toolCalls) {
      logger.info('tool_called', {
        agent_id,
        tool_name: call.toolName,
        tool_call_id: call.toolCallId,
      });
    }

    // Build a lookup map for tool results by toolCallId (not index).
    // Index-based alignment breaks when a call has no result or steps
    // have variable numbers of calls.
    const toolResultById = new Map<string, unknown>();
    for (const tr of toolResults) {
      if (tr.toolCallId) {
        toolResultById.set(tr.toolCallId, tr.result);
      }
    }

    // Extract memory updates from tool results
    const fallbackKey = options?.node_id ? `${options.node_id}_output` : 'agent_response';
    const memoryUpdates = extractMemoryUpdates(text, toolCalls, config.write_keys, fallbackKey);

    // Propagate taint: if any input memory keys were tainted, mark outputs as derived-tainted
    const outputKeys = Object.keys(memoryUpdates);
    if (outputKeys.length > 0) {
      const taintUpdates = propagateDerivedTaint(stateView.memory, outputKeys, agent_id);
      if (Object.keys(taintUpdates).length > 0) {
        const existingRegistry = getTaintRegistry(stateView.memory);
        memoryUpdates['_taint_registry'] = { ...existingRegistry, ...taintUpdates };
      }
    }

    // Collect tool execution metadata separately — not stored in memory
    // Correlate by toolCallId for correctness
    const toolExecutions = toolCalls
      .filter((call) => call.toolName !== 'save_to_memory')
      .map((call) => ({
        tool: call.toolName,
        args: call.input ?? call.args,
        result: toolResultById.get(call.toolCallId),
      }));

    const duration = Date.now() - startTime;

    // Build action — internal metadata is in metadata, not polluting memory
    const action: Action = {
      id: uuidv4(),
      idempotency_key: uuidv4(),
      type: 'update_memory',
      payload: {
        updates: memoryUpdates,
      },
      metadata: {
        node_id: agent_id,
        agent_id: agent_id,
        model: config.model,
        timestamp: new Date(),
        attempt,
        duration_ms: duration,
        token_usage: tokenUsage,
        tool_executions: toolExecutions.length > 0 ? toolExecutions : undefined,
      },
    };

    logger.info('completed', {
      agent_id,
      duration_ms: duration,
      tool_calls: toolCalls.length,
      tool_names: toolCalls.map((c) => c.toolName),
      input_tokens: tokenUsage.inputTokens,
      output_tokens: tokenUsage.outputTokens,
      total_tokens: tokenUsage.totalTokens,
      memory_keys_updated: Object.keys(memoryUpdates),
    });

    // Add span attributes for observability
    span.setAttribute('agent.model', config.model);
    span.setAttribute('agent.provider', config.provider);
    span.setAttribute('agent.duration_ms', duration);
    span.setAttribute('agent.tokens.input', tokenUsage.inputTokens);
    span.setAttribute('agent.tokens.output', tokenUsage.outputTokens);
    span.setAttribute('agent.tokens.total', tokenUsage.totalTokens);
    span.setAttribute('agent.tools_called', toolCalls.length);

    // Validate against Zero Trust permissions
    validateMemoryUpdatePermissions(action, config.write_keys);

    return action;
  });
}

/**
 * Create an {@link AbortController} that auto-aborts after the given timeout.
 *
 * @param timeoutMs - Milliseconds before the controller aborts.
 * @returns The timeout ID (for cleanup) and the controller.
 */
function createAbortControllerWithTimeout(timeoutMs: number) {
  const controller = new AbortController();
  return {
    timeoutId: setTimeout(() => controller.abort(), timeoutMs),
    controller,
  };
}

/**
 * Check whether a resolved tool entry is already a well-formed AI SDK `Tool`.
 *
 * The AI SDK `Tool` type discriminates on `type`:
 * - `undefined | 'function'` — standard tools created by `tool()`
 * - `'dynamic'`              — runtime tools created by `dynamicTool()` (e.g. `@ai-sdk/mcp`)
 * - `'provider'`             — provider-specific tools
 *
 * All three variants require `inputSchema` to be present, so we use that as
 * the structural guard in addition to `type`.
 *
 * @see https://github.com/vercel/ai — `@ai-sdk/provider-utils/src/types/tool.ts`
 */
function isAISDKTool(entry: Record<string, unknown>): boolean {
  const type = entry.type;
  const hasInputSchema = 'inputSchema' in entry;

  // dynamicTool() always sets type: 'dynamic'
  if (type === 'dynamic' && hasInputSchema) return true;

  // tool() leaves type undefined (or explicitly 'function')
  if ((type === undefined || type === 'function') && hasInputSchema) return true;

  // Provider tools have type: 'provider' + an id field
  if (type === 'provider' && typeof entry.id === 'string') return true;

  return false;
}

/**
 * Build an AI SDK {@link ToolSet} from resolved tool definitions.
 *
 * Tools arrive from `MCPConnectionManager.resolveTools()` in two shapes:
 *
 * 1. **Pre-formed AI SDK tools** (`dynamicTool()` objects from `@ai-sdk/mcp`,
 *    or `tool()` objects from other sources). Detected via {@link isAISDKTool}
 *    and passed through directly — re-wrapping would strip internal state.
 *
 * 2. **Raw tool definitions** — plain `{ description, parameters, execute }`
 *    objects (e.g. built-in tools like `save_to_memory`). Wrapped with the
 *    AI SDK `tool()` helper for schema validation.
 *
 * @param rawTools - Resolved tool definitions (may include execute callbacks).
 * @param agentId - The agent ID, for logging context.
 * @returns A {@link ToolSet} compatible with `streamText`.
 */
function buildToolSet(
  rawTools: Record<string, unknown>,
  agentId: string,
): ToolSet {
  const tools: ToolSet = {};

  for (const [name, raw] of Object.entries(rawTools)) {
    if (!raw || typeof raw !== 'object') {
      logger.warn('tool_skipped_invalid', { agent_id: agentId, tool_name: name, reason: 'not an object' });
      continue;
    }

    const entry = raw as Record<string, unknown>;

    // ── Pre-formed AI SDK tool ─────────────────────────────────────
    if (isAISDKTool(entry)) {
      tools[name] = raw as ToolSet[string];
      continue;
    }

    // ── Raw tool definition (built-in tools) ───────────────────────
    const description = entry.description;
    const schema = entry.inputSchema ?? entry.parameters;

    if (typeof description !== 'string' || !description) {
      logger.warn('tool_skipped_invalid', { agent_id: agentId, tool_name: name, reason: 'missing description' });
      continue;
    }

    if (!schema || typeof schema !== 'object') {
      logger.warn('tool_skipped_invalid', { agent_id: agentId, tool_name: name, reason: 'missing parameters/inputSchema' });
      continue;
    }

    const executeFn = typeof entry.execute === 'function'
      ? entry.execute as (args: Record<string, unknown>) => Promise<unknown>
      : undefined;

    tools[name] = tool({
      description,
      inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
      execute: executeFn
        ? async (args: Record<string, unknown>) => executeFn(args)
        : async (args: Record<string, unknown>) => args,
    });
  }

  return tools;
}
