/**
 * ⬛⬜🛣️ Agent Coordinator Durable Object
 * Central coordination hub for all agent activities
 */

import type { Env, AgentState, AgentJob, HealthStatus, ComponentHealth } from '../types';
import { generateId, createJob } from '../utils/helpers';

interface CoordinatorState {
  agents: Map<string, AgentState>;
  activeJobs: Map<string, AgentJob>;
  startTime: number;
  lastHealthCheck: number;
}

export class AgentCoordinator implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private coordinatorState: CoordinatorState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.coordinatorState = {
      agents: new Map(),
      activeJobs: new Map(),
      startTime: Date.now(),
      lastHealthCheck: 0,
    };

    // Initialize from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<CoordinatorState>('coordinatorState');
      if (stored) {
        this.coordinatorState = {
          ...stored,
          agents: new Map(Object.entries(stored.agents || {})),
          activeJobs: new Map(Object.entries(stored.activeJobs || {})),
        };
      }
    });
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('coordinatorState', {
      ...this.coordinatorState,
      agents: Object.fromEntries(this.coordinatorState.agents),
      activeJobs: Object.fromEntries(this.coordinatorState.activeJobs),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/register':
          return this.handleRegister(request);
        case '/heartbeat':
          return this.handleHeartbeat(request);
        case '/job/assign':
          return this.handleJobAssign(request);
        case '/job/complete':
          return this.handleJobComplete(request);
        case '/job/fail':
          return this.handleJobFail(request);
        case '/status':
          return this.handleStatus();
        case '/health':
          return this.handleHealth();
        case '/agents':
          return this.handleListAgents();
        case '/trigger-scrape':
          return this.handleTriggerScrape(request);
        case '/trigger-analysis':
          return this.handleTriggerAnalysis();
        default:
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
      }
    } catch (error) {
      console.error('Coordinator error:', error);
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private async handleRegister(request: Request): Promise<Response> {
    const body = await request.json<{ type: AgentState['type']; id?: string }>();
    const agentId = body.id || generateId('agent');

    const agent: AgentState = {
      id: agentId,
      type: body.type,
      status: 'idle',
      lastHeartbeat: Date.now(),
      metrics: {
        jobsProcessed: 0,
        jobsFailed: 0,
        avgProcessingTime: 0,
      },
    };

    this.coordinatorState.agents.set(agentId, agent);
    await this.saveState();

    console.log(`Agent registered: ${agentId} (${body.type})`);

    return new Response(JSON.stringify({ success: true, agentId }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleHeartbeat(request: Request): Promise<Response> {
    const body = await request.json<{ agentId: string; metrics?: Partial<AgentState['metrics']> }>();
    const agent = this.coordinatorState.agents.get(body.agentId);

    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    agent.lastHeartbeat = Date.now();
    if (body.metrics) {
      agent.metrics = { ...agent.metrics, ...body.metrics };
    }

    await this.saveState();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleJobAssign(request: Request): Promise<Response> {
    const body = await request.json<{ agentId: string; job: AgentJob }>();
    const agent = this.coordinatorState.agents.get(body.agentId);

    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    agent.status = 'working';
    agent.currentJob = body.job.id;
    body.job.status = 'running';
    body.job.updatedAt = Date.now();

    this.coordinatorState.activeJobs.set(body.job.id, body.job);
    await this.saveState();

    // Store job in KV for persistence
    await this.env.AGENT_STATE.put(`job:${body.job.id}`, JSON.stringify(body.job), {
      expirationTtl: 86400 * 7, // 7 days
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleJobComplete(request: Request): Promise<Response> {
    const body = await request.json<{ agentId: string; jobId: string; result?: unknown }>();
    const agent = this.coordinatorState.agents.get(body.agentId);
    const job = this.coordinatorState.activeJobs.get(body.jobId);

    if (!agent || !job) {
      return new Response(JSON.stringify({ error: 'Agent or job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update job
    job.status = 'completed';
    job.completedAt = Date.now();
    job.result = body.result;
    job.updatedAt = Date.now();

    // Update agent
    agent.status = 'idle';
    agent.currentJob = undefined;
    agent.metrics.jobsProcessed++;

    const duration = job.completedAt - job.createdAt;
    agent.metrics.lastJobDuration = duration;
    agent.metrics.avgProcessingTime =
      (agent.metrics.avgProcessingTime * (agent.metrics.jobsProcessed - 1) + duration) /
      agent.metrics.jobsProcessed;

    this.coordinatorState.activeJobs.delete(body.jobId);
    await this.saveState();

    // Update KV
    await this.env.AGENT_STATE.put(`job:${body.jobId}`, JSON.stringify(job), {
      expirationTtl: 86400 * 7,
    });

    console.log(`Job completed: ${body.jobId} by agent ${body.agentId}`);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleJobFail(request: Request): Promise<Response> {
    const body = await request.json<{ agentId: string; jobId: string; error: string }>();
    const agent = this.coordinatorState.agents.get(body.agentId);
    const job = this.coordinatorState.activeJobs.get(body.jobId);

    if (!agent || !job) {
      return new Response(JSON.stringify({ error: 'Agent or job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    job.error = body.error;
    job.updatedAt = Date.now();

    // Check if we should retry
    if (job.retries < job.maxRetries) {
      job.retries++;
      job.status = 'retrying';

      // Re-queue the job
      await this.env.JOBS_QUEUE.send(job);

      console.log(`Job ${body.jobId} failed, retrying (${job.retries}/${job.maxRetries})`);
    } else {
      job.status = 'failed';

      // Send to DLQ for self-resolution
      await this.env.DLQ_QUEUE.send(job);

      // Trigger self-healer
      const healerId = this.env.SELF_HEALER.idFromName('main');
      const healer = this.env.SELF_HEALER.get(healerId);
      await healer.fetch(new Request('http://internal/resolve', {
        method: 'POST',
        body: JSON.stringify({ job, error: body.error }),
      }));

      console.log(`Job ${body.jobId} permanently failed, sent to DLQ`);
    }

    // Update agent
    agent.status = 'idle';
    agent.currentJob = undefined;
    agent.metrics.jobsFailed++;

    this.coordinatorState.activeJobs.delete(body.jobId);
    await this.saveState();

    return new Response(JSON.stringify({ success: true, retrying: job.status === 'retrying' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleStatus(): Promise<Response> {
    const agents = Array.from(this.coordinatorState.agents.values());
    const activeJobs = Array.from(this.coordinatorState.activeJobs.values());

    return new Response(
      JSON.stringify({
        uptime: Date.now() - this.coordinatorState.startTime,
        agentCount: agents.length,
        activeJobCount: activeJobs.length,
        agents: agents.map((a) => ({
          id: a.id,
          type: a.type,
          status: a.status,
          jobsProcessed: a.metrics.jobsProcessed,
        })),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handleHealth(): Promise<Response> {
    const now = Date.now();
    const agents = Array.from(this.coordinatorState.agents.values());

    // Check component health
    const components: ComponentHealth[] = [
      {
        name: 'coordinator',
        status: 'healthy',
        lastCheck: now,
      },
      {
        name: 'kv_store',
        status: 'healthy',
        lastCheck: now,
      },
    ];

    // Check for stale agents
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    const staleAgents = agents.filter((a) => now - a.lastHeartbeat > staleThreshold);

    if (staleAgents.length > 0) {
      components.push({
        name: 'agents',
        status: 'degraded',
        lastCheck: now,
        message: `${staleAgents.length} stale agents detected`,
      });
    }

    // Count failed jobs in last 24h (from KV)
    let failedJobsLast24h = 0;
    try {
      const stored = await this.env.AGENT_STATE.get('failedJobsLast24h');
      if (stored) failedJobsLast24h = parseInt(stored, 10);
    } catch {
      // Ignore
    }

    const overallStatus =
      components.some((c) => c.status === 'unhealthy')
        ? 'unhealthy'
        : components.some((c) => c.status === 'degraded')
          ? 'degraded'
          : 'healthy';

    const health: HealthStatus = {
      status: overallStatus,
      timestamp: now,
      components,
      activeJobs: this.coordinatorState.activeJobs.size,
      failedJobsLast24h,
      uptime: now - this.coordinatorState.startTime,
    };

    this.coordinatorState.lastHealthCheck = now;

    return new Response(JSON.stringify(health), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleListAgents(): Promise<Response> {
    const agents = Array.from(this.coordinatorState.agents.values());
    return new Response(JSON.stringify({ agents }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleTriggerScrape(request: Request): Promise<Response> {
    const body = await request.json<{ repos?: string[] }>().catch(() => ({}));
    const repos = body.repos || this.env.PRIMARY_REPOS.split(',').map((r) => r.trim());

    const jobs: AgentJob[] = repos.map((repo) =>
      createJob('SCRAPE_REPO', { repo, org: this.env.GITHUB_ORG }, { priority: 'high' })
    );

    // Queue all scrape jobs
    for (const job of jobs) {
      await this.env.JOBS_QUEUE.send(job);
    }

    console.log(`Triggered scrape for ${repos.length} repos`);

    return new Response(
      JSON.stringify({
        success: true,
        jobsQueued: jobs.length,
        repos,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handleTriggerAnalysis(): Promise<Response> {
    const job = createJob(
      'ANALYZE_COHESIVENESS',
      {
        org: this.env.GITHUB_ORG,
        repos: this.env.PRIMARY_REPOS.split(',').map((r) => r.trim()),
      },
      { priority: 'normal' }
    );

    await this.env.JOBS_QUEUE.send(job);

    console.log('Triggered cohesiveness analysis');

    return new Response(JSON.stringify({ success: true, jobId: job.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
