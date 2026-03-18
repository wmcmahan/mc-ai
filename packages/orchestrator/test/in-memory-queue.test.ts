import { describe, test, expect, beforeEach } from 'vitest';
import { InMemoryWorkflowQueue } from '../src/persistence/in-memory-queue';

describe('InMemoryWorkflowQueue', () => {
  let queue: InMemoryWorkflowQueue;

  const defaultInput = () => ({
    type: 'start' as const,
    run_id: crypto.randomUUID(),
    graph_id: crypto.randomUUID(),
  });

  beforeEach(() => {
    queue = new InMemoryWorkflowQueue();
  });

  test('enqueue/dequeue basic flow', async () => {
    const input = defaultInput();
    const jobId = await queue.enqueue(input);
    expect(jobId).toBeTruthy();

    const job = await queue.dequeue('worker-1');
    expect(job).not.toBeNull();
    expect(job!.id).toBe(jobId);
    expect(job!.status).toBe('active');
    expect(job!.worker_id).toBe('worker-1');
    expect(job!.attempt).toBe(1);
    expect(job!.run_id).toBe(input.run_id);
  });

  test('priority ordering — lower priority dequeued first', async () => {
    const low = await queue.enqueue({ ...defaultInput(), priority: 10 });
    const high = await queue.enqueue({ ...defaultInput(), priority: 1 });

    const first = await queue.dequeue('w');
    expect(first!.id).toBe(high);

    const second = await queue.dequeue('w');
    expect(second!.id).toBe(low);
  });

  test('FIFO within same priority', async () => {
    const first = await queue.enqueue(defaultInput());
    // Tiny delay to ensure different created_at
    await new Promise(r => setTimeout(r, 5));
    const second = await queue.enqueue(defaultInput());

    const job1 = await queue.dequeue('w');
    expect(job1!.id).toBe(first);

    const job2 = await queue.dequeue('w');
    expect(job2!.id).toBe(second);
  });

  test('empty queue returns null', async () => {
    const job = await queue.dequeue('w');
    expect(job).toBeNull();
  });

  test('ack transitions to completed', async () => {
    const jobId = await queue.enqueue(defaultInput());
    await queue.dequeue('w');
    await queue.ack(jobId);

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('completed');
    expect(job!.worker_id).toBeNull();
  });

  test('nack with retries remaining returns to waiting', async () => {
    const jobId = await queue.enqueue({ ...defaultInput(), max_attempts: 3 });
    await queue.dequeue('w'); // attempt = 1
    await queue.nack(jobId, 'transient error');

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.last_error).toBe('transient error');
    expect(job!.attempt).toBe(1); // nack doesn't increment — dequeue does
  });

  test('nack exceeds max_attempts → dead_letter', async () => {
    const jobId = await queue.enqueue({ ...defaultInput(), max_attempts: 1 });
    await queue.dequeue('w'); // attempt = 1 (now equals max_attempts)
    await queue.nack(jobId, 'fatal error');

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('dead_letter');
    expect(job!.last_error).toBe('fatal error');
  });

  test('heartbeat extends visible_at', async () => {
    const jobId = await queue.enqueue(defaultInput());
    const job = await queue.dequeue('w');
    const originalVisibleAt = job!.visible_at!.getTime();

    // Small delay to get a different timestamp
    await new Promise(r => setTimeout(r, 10));
    await queue.heartbeat(jobId);

    const updated = await queue.getJob(jobId);
    expect(updated!.visible_at!.getTime()).toBeGreaterThan(originalVisibleAt);
  });

  test('release preserves attempt count and returns to waiting', async () => {
    const jobId = await queue.enqueue(defaultInput());
    await queue.dequeue('w'); // attempt = 1

    await queue.release(jobId);

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.attempt).toBe(1); // preserved, not incremented
    expect(job!.worker_id).toBeNull();
  });

  test('reclaimExpired returns jobs with expired visibility', async () => {
    const jobId = await queue.enqueue({
      ...defaultInput(),
      visibility_timeout_ms: 1, // 1ms — will expire immediately
    });
    await queue.dequeue('w');

    // Wait for visibility to expire
    await new Promise(r => setTimeout(r, 10));

    const count = await queue.reclaimExpired();
    expect(count).toBe(1);

    const job = await queue.getJob(jobId);
    expect(job!.status).toBe('waiting');
    expect(job!.worker_id).toBeNull();
  });

  test('dequeue skips active jobs', async () => {
    const id1 = await queue.enqueue(defaultInput());
    await queue.dequeue('w'); // id1 is now active

    const second = await queue.dequeue('w');
    expect(second).toBeNull(); // no more waiting jobs
  });

  test('getQueueDepth counts by status', async () => {
    // 1 dead_letter — enqueue and exhaust first so dequeue doesn't pick others
    const dlId = await queue.enqueue({ ...defaultInput(), max_attempts: 1 });
    await queue.dequeue('w');
    await queue.nack(dlId, 'dead');

    // 1 active
    await queue.enqueue(defaultInput());
    await queue.dequeue('w');

    // 2 waiting
    await queue.enqueue(defaultInput());
    await queue.enqueue(defaultInput());

    const depth = await queue.getQueueDepth();
    expect(depth.waiting).toBe(2);
    expect(depth.active).toBe(1);
    expect(depth.dead_letter).toBe(1);
  });
});
