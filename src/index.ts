/**
 * ⬛⬜🛣️ BlackRoad Cloudflare Workers Agent System
 *
 * A comprehensive agent system for:
 * - Scraping and monitoring GitHub repositories
 * - Ensuring cohesiveness across the BlackRoad organization
 * - Auto-updating when changes are detected
 * - Self-resolving failures autonomously
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, AgentJob, WebhookPayload, ApiResponse } from './types';
import { GitHubScraper } from './scrapers/GitHubScraper';
import { CohesivenessAnalyzer } from './analyzers/CohesivenessAnalyzer';
import { createJob, parseRepoList } from './utils/helpers';

// Re-export Durable Objects
export { AgentCoordinator } from './durable-objects/AgentCoordinator';
export { JobQueue } from './durable-objects/JobQueue';
export { RepoWatcher } from './durable-objects/RepoWatcher';
export { SelfHealer } from './durable-objects/SelfHealer';

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'BlackRoad Agent System',
    version: '1.0.0',
    status: 'operational',
    emoji: '⬛⬜🛣️',
    endpoints: [
      'GET /health',
      'GET /status',
      'POST /scrape/:org/:repo',
      'POST /scrape-all',
      'GET /repos/:org/:repo',
      'POST /analyze',
      'GET /report',
      'POST /webhook',
      'GET /jobs',
      'POST /jobs/trigger',
    ],
  });
});

// Detailed health check
app.get('/health', async (c) => {
  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  try {
    const response = await coordinator.fetch(new Request('http://internal/health'));
    const health = await response.json();
    return c.json(health);
  } catch (error) {
    return c.json(
      {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

// System status
app.get('/status', async (c) => {
  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const jobQueueId = c.env.JOB_QUEUE.idFromName('main');
  const jobQueue = c.env.JOB_QUEUE.get(jobQueueId);

  const watcherId = c.env.REPO_WATCHER.idFromName('main');
  const watcher = c.env.REPO_WATCHER.get(watcherId);

  const healerId = c.env.SELF_HEALER.idFromName('main');
  const healer = c.env.SELF_HEALER.get(healerId);

  try {
    const [coordStatus, queueStatus, watcherStatus, healerStatus] = await Promise.all([
      coordinator.fetch(new Request('http://internal/status')).then((r) => r.json()),
      jobQueue.fetch(new Request('http://internal/status')).then((r) => r.json()),
      watcher.fetch(new Request('http://internal/status')).then((r) => r.json()),
      healer.fetch(new Request('http://internal/status')).then((r) => r.json()),
    ]);

    return c.json({
      coordinator: coordStatus,
      jobQueue: queueStatus,
      repoWatcher: watcherStatus,
      selfHealer: healerStatus,
      timestamp: Date.now(),
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      500
    );
  }
});

// Scrape a specific repository
app.post('/scrape/:org/:repo', async (c) => {
  const { org, repo } = c.req.param();
  const scraper = new GitHubScraper(c.env);

  try {
    const result = await scraper.scrapeRepo(org, repo);
    return c.json<ApiResponse>({
      success: true,
      data: {
        metadata: result.metadata,
        fileCount: result.structure.length,
        dependencyCount: result.metadata.dependencies.length,
        workflowCount: result.workflows?.length || 0,
        healthScore: result.metadata.healthScore,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      500
    );
  }
});

// Scrape all configured repositories
app.post('/scrape-all', async (c) => {
  const repos = parseRepoList(c.env.PRIMARY_REPOS);
  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  try {
    const response = await coordinator.fetch(
      new Request('http://internal/trigger-scrape', {
        method: 'POST',
        body: JSON.stringify({ repos }),
      })
    );

    const result = await response.json();
    return c.json<ApiResponse>({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      500
    );
  }
});

// Get cached repository data
app.get('/repos/:org/:repo', async (c) => {
  const { org, repo } = c.req.param();
  const fullName = `${org}/${repo}`;

  const cached = await c.env.REPO_CACHE.get(`repo:${fullName}`);

  if (cached) {
    return c.json<ApiResponse>({
      success: true,
      data: JSON.parse(cached),
      timestamp: Date.now(),
    });
  }

  return c.json<ApiResponse>(
    {
      success: false,
      error: 'Repository not found in cache. Trigger a scrape first.',
      timestamp: Date.now(),
    },
    404
  );
});

// Run cohesiveness analysis
app.post('/analyze', async (c) => {
  const body = await c.req.json<{ repos?: string[] }>().catch(() => ({}));
  const repos = body.repos || parseRepoList(c.env.PRIMARY_REPOS);
  const analyzer = new CohesivenessAnalyzer(c.env);

  try {
    const report = await analyzer.analyzeRepos(c.env.GITHUB_ORG, repos);
    return c.json<ApiResponse>({
      success: true,
      data: report,
      timestamp: Date.now(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      500
    );
  }
});

// Get latest cohesiveness report
app.get('/report', async (c) => {
  const analyzer = new CohesivenessAnalyzer(c.env);
  const report = await analyzer.getLatestReport();

  if (report) {
    return c.json<ApiResponse>({
      success: true,
      data: report,
      timestamp: Date.now(),
    });
  }

  return c.json<ApiResponse>(
    {
      success: false,
      error: 'No report available. Run analysis first.',
      timestamp: Date.now(),
    },
    404
  );
});

// GitHub webhook handler
app.post('/webhook', async (c) => {
  const event = c.req.header('X-GitHub-Event');
  const signature = c.req.header('X-Hub-Signature-256');

  // TODO: Verify webhook signature if WEBHOOK_SECRET is configured

  const watcherId = c.env.REPO_WATCHER.idFromName('main');
  const watcher = c.env.REPO_WATCHER.get(watcherId);

  try {
    const body = await c.req.text();
    const response = await watcher.fetch(
      new Request('http://internal/webhook', {
        method: 'POST',
        headers: {
          'X-GitHub-Event': event || '',
          'Content-Type': 'application/json',
        },
        body,
      })
    );

    const result = await response.json();
    return c.json<ApiResponse>({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      500
    );
  }
});

// Get job queue status
app.get('/jobs', async (c) => {
  const jobQueueId = c.env.JOB_QUEUE.idFromName('main');
  const jobQueue = c.env.JOB_QUEUE.get(jobQueueId);

  try {
    const response = await jobQueue.fetch(new Request('http://internal/status'));
    const status = await response.json();
    return c.json<ApiResponse>({
      success: true,
      data: status,
      timestamp: Date.now(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      500
    );
  }
});

// Manually trigger a job
app.post('/jobs/trigger', async (c) => {
  const body = await c.req.json<{
    type: AgentJob['type'];
    payload?: Record<string, unknown>;
    priority?: AgentJob['priority'];
  }>();

  const job = createJob(body.type, body.payload || {}, { priority: body.priority });

  try {
    await c.env.JOBS_QUEUE.send(job);

    return c.json<ApiResponse>({
      success: true,
      data: { jobId: job.id, type: job.type, priority: job.priority },
      timestamp: Date.now(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      500
    );
  }
});

// Watch a repository
app.post('/watch/:org/:repo', async (c) => {
  const { org, repo } = c.req.param();
  const watcherId = c.env.REPO_WATCHER.idFromName('main');
  const watcher = c.env.REPO_WATCHER.get(watcherId);

  try {
    const response = await watcher.fetch(
      new Request('http://internal/watch', {
        method: 'POST',
        body: JSON.stringify({ org, repo }),
      })
    );

    const result = await response.json();
    return c.json<ApiResponse>({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      500
    );
  }
});

// Self-healer status
app.get('/healer', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('main');
  const healer = c.env.SELF_HEALER.get(healerId);

  try {
    const response = await healer.fetch(new Request('http://internal/status'));
    const status = await response.json();
    return c.json<ApiResponse>({
      success: true,
      data: status,
      timestamp: Date.now(),
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      },
      500
    );
  }
});

// Export the worker
export default {
  fetch: app.fetch,

  // Queue consumer for processing jobs
  async queue(batch: MessageBatch<AgentJob>, env: Env): Promise<void> {
    console.log(`Processing ${batch.messages.length} jobs from queue`);

    for (const message of batch.messages) {
      const job = message.body;

      try {
        await processJob(job, env);
        message.ack();
      } catch (error) {
        console.error(`Job ${job.id} failed:`, error);

        // Report failure to coordinator
        const coordinatorId = env.AGENT_COORDINATOR.idFromName('main');
        const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);

        await coordinator.fetch(
          new Request('http://internal/job/fail', {
            method: 'POST',
            body: JSON.stringify({
              agentId: 'queue-worker',
              jobId: job.id,
              error: error instanceof Error ? error.message : 'Unknown error',
            }),
          })
        );

        // Let the queue handle retries
        message.retry();
      }
    }
  },

  // Scheduled cron handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;
    console.log(`Cron triggered: ${cron}`);

    // Get Durable Object instances
    const coordinatorId = env.AGENT_COORDINATOR.idFromName('main');
    const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);

    const watcherId = env.REPO_WATCHER.idFromName('main');
    const watcher = env.REPO_WATCHER.get(watcherId);

    const healerId = env.SELF_HEALER.idFromName('main');
    const healer = env.SELF_HEALER.get(healerId);

    try {
      switch (cron) {
        // Every 15 minutes - Quick health check
        case '*/15 * * * *': {
          const healthResponse = await coordinator.fetch(new Request('http://internal/health'));
          const health = await healthResponse.json<{ status: string }>();

          if (health.status !== 'healthy') {
            // Trigger self-healing
            await healer.fetch(
              new Request('http://internal/resolve', {
                method: 'POST',
                body: JSON.stringify({
                  type: 'HEALTH_CHECK_FAILURE',
                  health,
                }),
              })
            );
          }
          break;
        }

        // Every hour - Full repo scan
        case '0 * * * *': {
          await watcher.fetch(new Request('http://internal/check-all', { method: 'POST' }));
          break;
        }

        // Daily - Deep cohesiveness analysis
        case '0 0 * * *': {
          await coordinator.fetch(
            new Request('http://internal/trigger-analysis', { method: 'POST' })
          );

          // Also check for updates
          await watcher.fetch(new Request('http://internal/check-updates', { method: 'POST' }));
          break;
        }

        // Weekly - Comprehensive self-resolution audit
        case '0 0 * * 0': {
          const patternsResponse = await healer.fetch(new Request('http://internal/patterns'));
          const { patterns } = await patternsResponse.json<{ patterns: unknown[] }>();

          console.log(`Weekly audit: ${patterns.length} failure patterns tracked`);

          // Clean up old data
          await env.RESOLUTION_LOG.delete('cleanup_marker');
          break;
        }
      }
    } catch (error) {
      console.error(`Cron ${cron} failed:`, error);

      // Self-heal cron failures
      await healer.fetch(
        new Request('http://internal/resolve', {
          method: 'POST',
          body: JSON.stringify({
            type: 'CRON_FAILURE',
            cron,
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        })
      );
    }
  },
};

// Job processor
async function processJob(job: AgentJob, env: Env): Promise<void> {
  console.log(`Processing job: ${job.id} (${job.type})`);

  switch (job.type) {
    case 'SCRAPE_REPO': {
      const { org, repo } = job.payload as { org: string; repo: string };
      const scraper = new GitHubScraper(env);
      await scraper.scrapeRepo(org, repo);
      break;
    }

    case 'ANALYZE_COHESIVENESS': {
      const { org, repos } = job.payload as { org: string; repos: string[] };
      const analyzer = new CohesivenessAnalyzer(env);
      await analyzer.analyzeRepos(org, repos || parseRepoList(env.PRIMARY_REPOS));
      break;
    }

    case 'SYNC_REPOS': {
      // Trigger scrape for all configured repos
      const repos = parseRepoList(env.PRIMARY_REPOS);
      for (const repo of repos) {
        const scrapeJob = createJob('SCRAPE_REPO', { org: env.GITHUB_ORG, repo });
        await env.JOBS_QUEUE.send(scrapeJob);
      }
      break;
    }

    case 'HEALTH_CHECK': {
      const coordinatorId = env.AGENT_COORDINATOR.idFromName('main');
      const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);
      await coordinator.fetch(new Request('http://internal/health'));
      break;
    }

    case 'UPDATE_CHECK': {
      const watcherId = env.REPO_WATCHER.idFromName('main');
      const watcher = env.REPO_WATCHER.get(watcherId);
      await watcher.fetch(new Request('http://internal/check-updates', { method: 'POST' }));
      break;
    }

    case 'SELF_HEAL': {
      const healerId = env.SELF_HEALER.idFromName('main');
      const healer = env.SELF_HEALER.get(healerId);
      await healer.fetch(
        new Request('http://internal/resolve', {
          method: 'POST',
          body: JSON.stringify(job.payload),
        })
      );
      break;
    }

    default:
      console.warn(`Unknown job type: ${job.type}`);
  }
}
