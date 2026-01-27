/**
 * ⬛⬜🛣️ Job Queue Durable Object
 * Manages job scheduling, prioritization, and distribution
 */

import type { Env, AgentJob, JobPriority, JobType } from '../types';
import { generateId, createJob, getBackoffDelay } from '../utils/helpers';

interface QueueState {
  jobs: AgentJob[];
  processingJobs: Map<string, AgentJob>;
  jobHistory: Array<{ id: string; type: JobType; status: string; completedAt: number }>;
  stats: {
    totalProcessed: number;
    totalFailed: number;
    avgWaitTime: number;
    avgProcessingTime: number;
  };
}

const PRIORITY_ORDER: Record<JobPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export class JobQueue implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private queueState: QueueState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.queueState = {
      jobs: [],
      processingJobs: new Map(),
      jobHistory: [],
      stats: {
        totalProcessed: 0,
        totalFailed: 0,
        avgWaitTime: 0,
        avgProcessingTime: 0,
      },
    };

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<QueueState>('queueState');
      if (stored) {
        this.queueState = {
          ...stored,
          processingJobs: new Map(Object.entries(stored.processingJobs || {})),
        };
      }
    });
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('queueState', {
      ...this.queueState,
      processingJobs: Object.fromEntries(this.queueState.processingJobs),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/enqueue':
          return this.handleEnqueue(request);
        case '/dequeue':
          return this.handleDequeue(request);
        case '/complete':
          return this.handleComplete(request);
        case '/fail':
          return this.handleFail(request);
        case '/status':
          return this.handleStatus();
        case '/peek':
          return this.handlePeek(request);
        case '/cancel':
          return this.handleCancel(request);
        case '/schedule':
          return this.handleSchedule(request);
        case '/bulk-enqueue':
          return this.handleBulkEnqueue(request);
        default:
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
      }
    } catch (error) {
      console.error('JobQueue error:', error);
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    const job = await request.json<AgentJob>();

    // Ensure job has required fields
    if (!job.id) job.id = generateId('job');
    if (!job.createdAt) job.createdAt = Date.now();
    job.updatedAt = Date.now();
    job.status = 'pending';

    // Insert job in priority order
    this.insertJobByPriority(job);
    await this.saveState();

    console.log(`Job enqueued: ${job.id} (${job.type}, priority: ${job.priority})`);

    return new Response(JSON.stringify({ success: true, jobId: job.id, position: this.getJobPosition(job.id) }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleBulkEnqueue(request: Request): Promise<Response> {
    const { jobs } = await request.json<{ jobs: AgentJob[] }>();

    for (const job of jobs) {
      if (!job.id) job.id = generateId('job');
      if (!job.createdAt) job.createdAt = Date.now();
      job.updatedAt = Date.now();
      job.status = 'pending';
      this.insertJobByPriority(job);
    }

    await this.saveState();

    console.log(`Bulk enqueued ${jobs.length} jobs`);

    return new Response(
      JSON.stringify({
        success: true,
        jobIds: jobs.map((j) => j.id),
        queueSize: this.queueState.jobs.length,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private insertJobByPriority(job: AgentJob): void {
    const jobPriority = PRIORITY_ORDER[job.priority];

    // Find the right position based on priority and scheduling
    let insertIndex = this.queueState.jobs.length;

    for (let i = 0; i < this.queueState.jobs.length; i++) {
      const existingJob = this.queueState.jobs[i];
      const existingPriority = PRIORITY_ORDER[existingJob.priority];

      // Scheduled jobs go to the back unless their time has come
      if (job.scheduledFor && job.scheduledFor > Date.now()) {
        continue;
      }

      // Higher priority (lower number) goes first
      if (jobPriority < existingPriority) {
        insertIndex = i;
        break;
      }

      // Same priority - FIFO
      if (jobPriority === existingPriority && !existingJob.scheduledFor) {
        insertIndex = i + 1;
      }
    }

    this.queueState.jobs.splice(insertIndex, 0, job);
  }

  private getJobPosition(jobId: string): number {
    return this.queueState.jobs.findIndex((j) => j.id === jobId) + 1;
  }

  private async handleDequeue(request: Request): Promise<Response> {
    const body = await request.json<{ agentId: string; types?: JobType[] }>().catch(() => ({}));
    const now = Date.now();

    // Find the first available job that matches criteria
    let jobIndex = -1;
    for (let i = 0; i < this.queueState.jobs.length; i++) {
      const job = this.queueState.jobs[i];

      // Skip scheduled jobs that aren't ready
      if (job.scheduledFor && job.scheduledFor > now) continue;

      // Filter by job type if specified
      if (body.types && !body.types.includes(job.type)) continue;

      jobIndex = i;
      break;
    }

    if (jobIndex === -1) {
      return new Response(JSON.stringify({ job: null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Remove from queue and mark as processing
    const job = this.queueState.jobs.splice(jobIndex, 1)[0];
    job.status = 'running';
    job.updatedAt = now;

    this.queueState.processingJobs.set(job.id, job);
    await this.saveState();

    // Notify coordinator
    if (body.agentId) {
      const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('main');
      const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);
      await coordinator.fetch(new Request('http://internal/job/assign', {
        method: 'POST',
        body: JSON.stringify({ agentId: body.agentId, job }),
      }));
    }

    const waitTime = now - job.createdAt;
    console.log(`Job dequeued: ${job.id} (waited ${Math.round(waitTime / 1000)}s)`);

    return new Response(JSON.stringify({ job, waitTime }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleComplete(request: Request): Promise<Response> {
    const { jobId, result } = await request.json<{ jobId: string; result?: unknown }>();
    const job = this.queueState.processingJobs.get(jobId);

    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found in processing' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const now = Date.now();
    job.status = 'completed';
    job.completedAt = now;
    job.result = result;
    job.updatedAt = now;

    // Update stats
    const processingTime = now - (job.updatedAt - (now - job.createdAt));
    this.queueState.stats.totalProcessed++;
    this.queueState.stats.avgProcessingTime =
      (this.queueState.stats.avgProcessingTime * (this.queueState.stats.totalProcessed - 1) + processingTime) /
      this.queueState.stats.totalProcessed;

    // Add to history (keep last 100)
    this.queueState.jobHistory.push({
      id: job.id,
      type: job.type,
      status: 'completed',
      completedAt: now,
    });
    if (this.queueState.jobHistory.length > 100) {
      this.queueState.jobHistory.shift();
    }

    this.queueState.processingJobs.delete(jobId);
    await this.saveState();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleFail(request: Request): Promise<Response> {
    const { jobId, error, retry = true } = await request.json<{
      jobId: string;
      error: string;
      retry?: boolean;
    }>();

    const job = this.queueState.processingJobs.get(jobId);

    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found in processing' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const now = Date.now();
    job.error = error;
    job.updatedAt = now;

    // Handle retry
    if (retry && job.retries < job.maxRetries) {
      job.retries++;
      job.status = 'retrying';

      // Calculate backoff delay
      const delay = getBackoffDelay(job.retries);
      job.scheduledFor = now + delay;

      // Re-add to queue
      this.insertJobByPriority(job);
      this.queueState.processingJobs.delete(jobId);

      console.log(`Job ${jobId} failed, scheduled retry in ${Math.round(delay / 1000)}s`);
    } else {
      job.status = 'failed';
      this.queueState.stats.totalFailed++;

      // Add to history
      this.queueState.jobHistory.push({
        id: job.id,
        type: job.type,
        status: 'failed',
        completedAt: now,
      });

      this.queueState.processingJobs.delete(jobId);

      // Send to DLQ
      await this.env.DLQ_QUEUE.send(job);

      console.log(`Job ${jobId} permanently failed after ${job.retries} retries`);
    }

    await this.saveState();

    return new Response(
      JSON.stringify({
        success: true,
        retrying: job.status === 'retrying',
        retriesLeft: job.maxRetries - job.retries,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handleStatus(): Promise<Response> {
    const now = Date.now();

    // Count scheduled jobs
    const scheduledJobs = this.queueState.jobs.filter((j) => j.scheduledFor && j.scheduledFor > now);

    // Group by type
    const byType: Record<string, number> = {};
    for (const job of this.queueState.jobs) {
      byType[job.type] = (byType[job.type] || 0) + 1;
    }

    // Group by priority
    const byPriority: Record<string, number> = {};
    for (const job of this.queueState.jobs) {
      byPriority[job.priority] = (byPriority[job.priority] || 0) + 1;
    }

    return new Response(
      JSON.stringify({
        queueLength: this.queueState.jobs.length,
        processingCount: this.queueState.processingJobs.size,
        scheduledCount: scheduledJobs.length,
        byType,
        byPriority,
        stats: this.queueState.stats,
        recentHistory: this.queueState.jobHistory.slice(-10),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handlePeek(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const count = parseInt(url.searchParams.get('count') || '5', 10);

    const jobs = this.queueState.jobs.slice(0, count);

    return new Response(JSON.stringify({ jobs }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCancel(request: Request): Promise<Response> {
    const { jobId } = await request.json<{ jobId: string }>();

    // Check pending queue
    const pendingIndex = this.queueState.jobs.findIndex((j) => j.id === jobId);
    if (pendingIndex !== -1) {
      this.queueState.jobs.splice(pendingIndex, 1);
      await this.saveState();
      return new Response(JSON.stringify({ success: true, wasProcessing: false }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check processing
    if (this.queueState.processingJobs.has(jobId)) {
      this.queueState.processingJobs.delete(jobId);
      await this.saveState();
      return new Response(JSON.stringify({ success: true, wasProcessing: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Job not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleSchedule(request: Request): Promise<Response> {
    const { job, runAt } = await request.json<{ job: Omit<AgentJob, 'scheduledFor'>; runAt: number }>();

    const scheduledJob: AgentJob = {
      ...job,
      id: job.id || generateId('job'),
      scheduledFor: runAt,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.insertJobByPriority(scheduledJob);
    await this.saveState();

    const delay = runAt - Date.now();
    console.log(`Job scheduled: ${scheduledJob.id} (runs in ${Math.round(delay / 1000)}s)`);

    return new Response(
      JSON.stringify({
        success: true,
        jobId: scheduledJob.id,
        scheduledFor: runAt,
        delay,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}
