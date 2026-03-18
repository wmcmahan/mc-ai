/**
 * Workflow Worker
 *
 * Polls a {@link WorkflowQueue} for jobs and executes each one
 * using the existing {@link GraphRunner}. Each workflow runs on
 * one worker for its entire lifetime — no changes to GraphRunner.
 *
 * Key behaviors:
 * - Crash recovery via event log replay (`GraphRunner.recover()`)
 * - HITL pauses release the worker slot (no blocking)
 * - Heartbeat keeps visibility timeout alive during long runs
 * - Graceful shutdown finishes in-flight work
 *
 * @module runner/worker
 */

import { EventEmitter } from 'events';
import { GraphRunner } from './graph-runner.js';
import type { GraphRunnerOptions, HumanResponse } from './graph-runner.js';
import type { WorkflowQueue, WorkflowJob } from '../persistence/queue-interfaces.js';
import type { PersistenceProvider } from '../persistence/interfaces.js';
import type { EventLogWriter } from '../db/event-log.js';
import type { WorkflowState } from '../types/state.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('worker');

// ─── Types ──────────────────────────────────────────────────────────────

/** Configuration for a {@link WorkflowWorker}. */
export interface WorkflowWorkerOptions {
  /** Unique worker identifier (defaults to `crypto.randomUUID()`). */
  workerId?: string;
  /** Queue to poll for jobs. */
  queue: WorkflowQueue;
  /** Persistence provider for loading graphs and saving state. */
  persistence: PersistenceProvider;
  /** Event log writer for durable execution / crash recovery. */
  eventLog: EventLogWriter;
  /**
   * Factory for additional GraphRunner options per job.
   * Use this to inject toolResolver, modelResolver, middleware, etc.
   */
  runnerOptionsFactory?: (job: WorkflowJob) => Partial<GraphRunnerOptions>;
  /** Maximum concurrent jobs (default: 1). */
  concurrency?: number;
  /** Polling interval in milliseconds (default: 1000). */
  pollIntervalMs?: number;
  /** Heartbeat interval in milliseconds (default: 60000). */
  heartbeatIntervalMs?: number;
  /** Interval for reclaiming expired jobs in milliseconds (default: 30000). */
  reclaimIntervalMs?: number;
  /** Grace period for in-flight work during shutdown in milliseconds (default: 30000). */
  shutdownGracePeriodMs?: number;
}

/** Events emitted by {@link WorkflowWorker}. */
export interface WorkflowWorkerEvents {
  'job:claimed': { jobId: string; runId: string };
  'job:completed': { jobId: string; runId: string };
  'job:failed': { jobId: string; runId: string; error: string };
  'job:released': { jobId: string; runId: string };
  'job:dead_letter': { jobId: string; runId: string; error: string };
  'worker:started': { workerId: string };
  'worker:stopped': { workerId: string };
}

// ─── Worker ─────────────────────────────────────────────────────────────

/**
 * Workflow worker that polls a queue and runs workflows via GraphRunner.
 *
 * ```typescript
 * const worker = new WorkflowWorker({
 *   queue,
 *   persistence,
 *   eventLog,
 *   concurrency: 2,
 * });
 * await worker.start();
 * // ...later...
 * await worker.stop();
 * ```
 */
export class WorkflowWorker extends EventEmitter {
  readonly workerId: string;

  private readonly queue: WorkflowQueue;
  private readonly persistence: PersistenceProvider;
  private readonly eventLog: EventLogWriter;
  private readonly runnerOptionsFactory?: (job: WorkflowJob) => Partial<GraphRunnerOptions>;

  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reclaimIntervalMs: number;
  private readonly shutdownGracePeriodMs: number;

  private running = false;
  private pollPromise: Promise<void> | null = null;

  /** In-flight jobs: jobId → { runner, heartbeatTimer } */
  private readonly activeJobs = new Map<string, {
    runner: GraphRunner | null;
    heartbeatTimer: ReturnType<typeof setInterval>;
    promise: Promise<void>;
  }>();

  private reclaimTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WorkflowWorkerOptions) {
    super();
    this.workerId = options.workerId ?? crypto.randomUUID();
    this.queue = options.queue;
    this.persistence = options.persistence;
    this.eventLog = options.eventLog;
    this.runnerOptionsFactory = options.runnerOptionsFactory;
    this.concurrency = options.concurrency ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
    this.reclaimIntervalMs = options.reclaimIntervalMs ?? 30_000;
    this.shutdownGracePeriodMs = options.shutdownGracePeriodMs ?? 30_000;
  }

  /** Start the poll loop and reclaim timer. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    logger.info('worker_starting', { worker_id: this.workerId, concurrency: this.concurrency });

    // Start periodic reclaim of expired jobs
    this.reclaimTimer = setInterval(async () => {
      try {
        const count = await this.queue.reclaimExpired();
        if (count > 0) {
          logger.info('reclaimed_expired_jobs', { count, worker_id: this.workerId });
        }
      } catch (err) {
        logger.error('reclaim_error', { error: (err as Error).message });
      }
    }, this.reclaimIntervalMs);

    this.emit('worker:started', { workerId: this.workerId });

    // Start poll loop
    this.pollPromise = this.pollLoop();
  }

  /** Stop the worker gracefully. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    logger.info('worker_stopping', { worker_id: this.workerId, active_jobs: this.activeJobs.size });

    // Clear reclaim timer
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }

    // Request shutdown on all active runners
    for (const { runner } of this.activeJobs.values()) {
      runner?.shutdown();
    }

    // Wait for in-flight work up to grace period
    if (this.activeJobs.size > 0) {
      const promises = [...this.activeJobs.values()].map(a => a.promise);
      const timeout = new Promise<void>(resolve =>
        setTimeout(resolve, this.shutdownGracePeriodMs),
      );
      await Promise.race([Promise.allSettled(promises), timeout]);
    }

    // Release any remaining active jobs
    for (const [jobId, { heartbeatTimer }] of this.activeJobs.entries()) {
      clearInterval(heartbeatTimer);
      try {
        await this.queue.release(jobId);
      } catch (err) {
        logger.error('release_on_shutdown_error', { job_id: jobId, error: (err as Error).message });
      }
    }
    this.activeJobs.clear();

    // Wait for poll loop to exit
    if (this.pollPromise) {
      await this.pollPromise;
      this.pollPromise = null;
    }

    this.emit('worker:stopped', { workerId: this.workerId });
    logger.info('worker_stopped', { worker_id: this.workerId });
  }

  /** Number of currently active jobs. */
  get activeJobCount(): number {
    return this.activeJobs.size;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      // Wait for a slot to open
      if (this.activeJobs.size >= this.concurrency) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      try {
        const job = await this.queue.dequeue(this.workerId);
        if (!job) {
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        this.emit('job:claimed', { jobId: job.id, runId: job.run_id });
        logger.info('job_claimed', {
          job_id: job.id,
          run_id: job.run_id,
          type: job.type,
          attempt: job.attempt,
        });

        // Launch job processing — non-blocking
        const promise = this.processJob(job);
        const heartbeatTimer = setInterval(async () => {
          try {
            await this.queue.heartbeat(job.id);
          } catch (err) {
            logger.error('heartbeat_error', { job_id: job.id, error: (err as Error).message });
          }
        }, this.heartbeatIntervalMs);

        this.activeJobs.set(job.id, {
          runner: null as unknown as GraphRunner, // set inside processJob
          heartbeatTimer,
          promise,
        });
      } catch (err) {
        logger.error('poll_error', { error: (err as Error).message });
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private async processJob(job: WorkflowJob): Promise<void> {
    try {
      // 1. Load graph
      const graph = await this.persistence.loadGraph(job.graph_id);
      if (!graph) {
        await this.queue.nack(job.id, `Graph not found: ${job.graph_id}`);
        this.emit('job:failed', { jobId: job.id, runId: job.run_id, error: 'Graph not found' });
        return;
      }

      // 2. Build runner options
      const persistStateFn = (state: WorkflowState) =>
        this.persistence.saveWorkflowSnapshot(state);

      const extraOptions = this.runnerOptionsFactory?.(job) ?? {};
      const runnerOptions: GraphRunnerOptions = {
        ...extraOptions,
        persistStateFn,
        eventLog: this.eventLog,
        loadGraphFn: (graphId: string) => this.persistence.loadGraph(graphId),
      };

      // 3. Determine if recovery is needed
      //    Even 'start' jobs may need recovery if a previous worker crashed mid-execution
      const latestSeqId = await this.eventLog.getLatestSequenceId(job.run_id);
      let runner: GraphRunner;

      if (latestSeqId >= 0) {
        // Events exist — recover from event log
        runner = await GraphRunner.recover(
          graph,
          job.run_id,
          this.eventLog,
          runnerOptions,
        );
        logger.info('job_recovered', { job_id: job.id, run_id: job.run_id, latest_seq: latestSeqId });
      } else {
        // Fresh start
        const initialState = (job.initial_state ?? {}) as Partial<WorkflowState>;
        const { createWorkflowState } = await import('../types/state.js');
        const state = createWorkflowState({
          workflow_id: graph.id,
          run_id: job.run_id,
          goal: (initialState.goal as string) ?? '',
          ...initialState,
        });
        runner = new GraphRunner(graph, state, runnerOptions);
      }

      // Store runner reference for shutdown
      const entry = this.activeJobs.get(job.id);
      if (entry) {
        entry.runner = runner;
      }

      // 4. Apply human response for HITL resume
      if (job.type === 'resume' && job.human_response) {
        runner.applyHumanResponse(job.human_response as HumanResponse);
      }

      // 5. Execute
      const result = await runner.run();

      // 6. Route based on result status
      if (result.status === 'waiting') {
        // HITL pause — release without penalty
        await this.queue.release(job.id);
        this.emit('job:released', { jobId: job.id, runId: job.run_id });
        logger.info('job_released_hitl', { job_id: job.id, run_id: job.run_id });
      } else {
        // Terminal status — mark completed
        await this.queue.ack(job.id);
        this.emit('job:completed', { jobId: job.id, runId: job.run_id });
        logger.info('job_completed', { job_id: job.id, run_id: job.run_id, status: result.status });
      }
    } catch (err) {
      const errorMsg = (err as Error).message ?? String(err);
      logger.error('job_processing_error', {
        job_id: job.id,
        run_id: job.run_id,
        error: errorMsg,
      });

      try {
        await this.queue.nack(job.id, errorMsg);

        // Check if it was dead-lettered
        const updatedJob = await this.queue.getJob(job.id);
        if (updatedJob?.status === 'dead_letter') {
          this.emit('job:dead_letter', { jobId: job.id, runId: job.run_id, error: errorMsg });
        } else {
          this.emit('job:failed', { jobId: job.id, runId: job.run_id, error: errorMsg });
        }
      } catch (nackErr) {
        logger.error('nack_error', { job_id: job.id, error: (nackErr as Error).message });
      }
    } finally {
      // Cleanup
      const entry = this.activeJobs.get(job.id);
      if (entry) {
        clearInterval(entry.heartbeatTimer);
      }
      this.activeJobs.delete(job.id);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
