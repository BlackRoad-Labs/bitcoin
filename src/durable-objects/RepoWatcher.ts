/**
 * ⬛⬜🛣️ Repo Watcher Durable Object
 * Monitors repositories for changes and triggers updates
 */

import type { Env, RepoMetadata, ScrapedRepo, AgentJob } from '../types';
import { generateId, createJob, parseRepoList } from '../utils/helpers';

interface WatchedRepo {
  org: string;
  name: string;
  fullName: string;
  lastChecked: number;
  lastCommitSha?: string;
  lastCommitDate?: string;
  checkInterval: number;
  enabled: boolean;
  consecutiveFailures: number;
}

interface WatcherState {
  repos: Map<string, WatchedRepo>;
  lastFullScan: number;
  lastUpdateCheck: number;
  updateAvailable: boolean;
  selfVersion: string;
}

export class RepoWatcher implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private watcherState: WatcherState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.watcherState = {
      repos: new Map(),
      lastFullScan: 0,
      lastUpdateCheck: 0,
      updateAvailable: false,
      selfVersion: '1.0.0',
    };

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<WatcherState>('watcherState');
      if (stored) {
        this.watcherState = {
          ...stored,
          repos: new Map(Object.entries(stored.repos || {})),
        };
      }
    });
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('watcherState', {
      ...this.watcherState,
      repos: Object.fromEntries(this.watcherState.repos),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/watch':
          return this.handleWatch(request);
        case '/unwatch':
          return this.handleUnwatch(request);
        case '/check':
          return this.handleCheck(request);
        case '/check-all':
          return this.handleCheckAll();
        case '/status':
          return this.handleStatus();
        case '/update':
          return this.handleUpdate(request);
        case '/check-updates':
          return this.handleCheckUpdates();
        case '/webhook':
          return this.handleWebhook(request);
        default:
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
      }
    } catch (error) {
      console.error('RepoWatcher error:', error);
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private async handleWatch(request: Request): Promise<Response> {
    const { org, repo, checkInterval = 3600000 } = await request.json<{
      org: string;
      repo: string;
      checkInterval?: number;
    }>();

    const fullName = `${org}/${repo}`;
    const watchedRepo: WatchedRepo = {
      org,
      name: repo,
      fullName,
      lastChecked: 0,
      checkInterval,
      enabled: true,
      consecutiveFailures: 0,
    };

    this.watcherState.repos.set(fullName, watchedRepo);
    await this.saveState();

    // Trigger initial scrape
    const job = createJob('SCRAPE_REPO', { org, repo }, { priority: 'high' });
    await this.env.JOBS_QUEUE.send(job);

    console.log(`Now watching: ${fullName} (interval: ${checkInterval}ms)`);

    return new Response(JSON.stringify({ success: true, watching: fullName }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleUnwatch(request: Request): Promise<Response> {
    const { fullName } = await request.json<{ fullName: string }>();

    if (this.watcherState.repos.has(fullName)) {
      this.watcherState.repos.delete(fullName);
      await this.saveState();

      return new Response(JSON.stringify({ success: true, removed: fullName }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Repo not watched' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCheck(request: Request): Promise<Response> {
    const { fullName } = await request.json<{ fullName: string }>();
    const repo = this.watcherState.repos.get(fullName);

    if (!repo) {
      return new Response(JSON.stringify({ error: 'Repo not watched' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await this.checkRepo(repo);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCheckAll(): Promise<Response> {
    const now = Date.now();
    const results: Array<{ repo: string; changed: boolean; error?: string }> = [];

    for (const repo of this.watcherState.repos.values()) {
      if (!repo.enabled) continue;

      // Check if interval has passed
      if (now - repo.lastChecked < repo.checkInterval) continue;

      try {
        const result = await this.checkRepo(repo);
        results.push({ repo: repo.fullName, changed: result.changed });
      } catch (error) {
        results.push({
          repo: repo.fullName,
          changed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.watcherState.lastFullScan = now;
    await this.saveState();

    return new Response(JSON.stringify({ checked: results.length, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async checkRepo(repo: WatchedRepo): Promise<{ changed: boolean; newSha?: string }> {
    const now = Date.now();

    try {
      // Fetch latest commit from GitHub API
      const headers: HeadersInit = {
        'User-Agent': 'BlackRoad-Agent/1.0',
        Accept: 'application/vnd.github.v3+json',
      };

      if (this.env.GITHUB_TOKEN) {
        headers['Authorization'] = `token ${this.env.GITHUB_TOKEN}`;
      }

      const response = await fetch(
        `https://api.github.com/repos/${repo.fullName}/commits?per_page=1`,
        { headers }
      );

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const commits = await response.json<Array<{ sha: string; commit: { committer: { date: string } } }>>();

      if (commits.length === 0) {
        return { changed: false };
      }

      const latestSha = commits[0].sha;
      const latestDate = commits[0].commit.committer.date;

      repo.lastChecked = now;
      repo.consecutiveFailures = 0;

      // Check if changed
      if (repo.lastCommitSha && repo.lastCommitSha !== latestSha) {
        repo.lastCommitSha = latestSha;
        repo.lastCommitDate = latestDate;
        await this.saveState();

        // Trigger scrape job
        const job = createJob(
          'SCRAPE_REPO',
          { org: repo.org, repo: repo.name, triggerReason: 'change_detected' },
          { priority: 'high' }
        );
        await this.env.JOBS_QUEUE.send(job);

        console.log(`Change detected in ${repo.fullName}: ${latestSha}`);
        return { changed: true, newSha: latestSha };
      }

      // Update sha if first check
      if (!repo.lastCommitSha) {
        repo.lastCommitSha = latestSha;
        repo.lastCommitDate = latestDate;
      }

      await this.saveState();
      return { changed: false };
    } catch (error) {
      repo.consecutiveFailures++;
      repo.lastChecked = now;

      // Disable if too many failures
      if (repo.consecutiveFailures >= 5) {
        repo.enabled = false;
        console.error(`Disabled watching ${repo.fullName} due to consecutive failures`);

        // Trigger self-healing
        const healerId = this.env.SELF_HEALER.idFromName('main');
        const healer = this.env.SELF_HEALER.get(healerId);
        await healer.fetch(new Request('http://internal/resolve', {
          method: 'POST',
          body: JSON.stringify({
            type: 'REPO_WATCH_FAILURE',
            repo: repo.fullName,
            failures: repo.consecutiveFailures,
          }),
        }));
      }

      await this.saveState();
      throw error;
    }
  }

  private async handleStatus(): Promise<Response> {
    const repos = Array.from(this.watcherState.repos.values());
    const enabled = repos.filter((r) => r.enabled);
    const failing = repos.filter((r) => r.consecutiveFailures > 0);

    return new Response(
      JSON.stringify({
        totalWatched: repos.length,
        enabledCount: enabled.length,
        failingCount: failing.length,
        lastFullScan: this.watcherState.lastFullScan,
        lastUpdateCheck: this.watcherState.lastUpdateCheck,
        updateAvailable: this.watcherState.updateAvailable,
        selfVersion: this.watcherState.selfVersion,
        repos: repos.map((r) => ({
          fullName: r.fullName,
          enabled: r.enabled,
          lastChecked: r.lastChecked,
          lastCommitSha: r.lastCommitSha?.substring(0, 7),
          failures: r.consecutiveFailures,
        })),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handleUpdate(request: Request): Promise<Response> {
    const { repoFullName, commitSha, commitDate } = await request.json<{
      repoFullName: string;
      commitSha: string;
      commitDate?: string;
    }>();

    const repo = this.watcherState.repos.get(repoFullName);

    if (!repo) {
      return new Response(JSON.stringify({ error: 'Repo not watched' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const oldSha = repo.lastCommitSha;
    repo.lastCommitSha = commitSha;
    repo.lastCommitDate = commitDate;
    repo.lastChecked = Date.now();

    await this.saveState();

    return new Response(
      JSON.stringify({
        success: true,
        oldSha: oldSha?.substring(0, 7),
        newSha: commitSha.substring(0, 7),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handleCheckUpdates(): Promise<Response> {
    // Check for self-updates (e.g., by checking a specific repo for new versions)
    const now = Date.now();

    try {
      // This would typically check a releases endpoint or version file
      // For now, we'll use a simple mechanism

      const headers: HeadersInit = {
        'User-Agent': 'BlackRoad-Agent/1.0',
        Accept: 'application/vnd.github.v3+json',
      };

      if (this.env.GITHUB_TOKEN) {
        headers['Authorization'] = `token ${this.env.GITHUB_TOKEN}`;
      }

      // Check for releases in the main repo
      const response = await fetch(
        `https://api.github.com/repos/${this.env.GITHUB_ORG}/bitcoin/releases/latest`,
        { headers }
      );

      if (response.ok) {
        const release = await response.json<{ tag_name: string; name: string }>();
        const latestVersion = release.tag_name.replace(/^v/, '');

        if (latestVersion !== this.watcherState.selfVersion) {
          this.watcherState.updateAvailable = true;

          // Trigger self-update job
          const job = createJob(
            'UPDATE_CHECK',
            {
              currentVersion: this.watcherState.selfVersion,
              latestVersion,
              releaseInfo: release,
            },
            { priority: 'critical' }
          );
          await this.env.JOBS_QUEUE.send(job);

          console.log(`Update available: ${this.watcherState.selfVersion} -> ${latestVersion}`);
        }
      }

      this.watcherState.lastUpdateCheck = now;
      await this.saveState();

      return new Response(
        JSON.stringify({
          currentVersion: this.watcherState.selfVersion,
          updateAvailable: this.watcherState.updateAvailable,
          lastCheck: now,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private async handleWebhook(request: Request): Promise<Response> {
    const event = request.headers.get('X-GitHub-Event');
    const payload = await request.json<{
      repository?: { full_name: string };
      ref?: string;
      commits?: Array<{ id: string; message: string }>;
      action?: string;
    }>();

    console.log(`Webhook received: ${event}`);

    if (event === 'push' && payload.repository) {
      const fullName = payload.repository.full_name;
      const repo = this.watcherState.repos.get(fullName);

      if (repo) {
        // Trigger immediate scrape
        const job = createJob(
          'SCRAPE_REPO',
          {
            org: repo.org,
            repo: repo.name,
            triggerReason: 'webhook_push',
            commits: payload.commits?.slice(0, 5),
          },
          { priority: 'critical' }
        );
        await this.env.JOBS_QUEUE.send(job);

        console.log(`Webhook triggered scrape for ${fullName}`);

        return new Response(JSON.stringify({ success: true, action: 'scrape_triggered' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Handle workflow_run events for CI/CD integration
    if (event === 'workflow_run' && payload.action === 'completed') {
      const job = createJob(
        'ANALYZE_COHESIVENESS',
        {
          triggerReason: 'workflow_completed',
          repository: payload.repository?.full_name,
        },
        { priority: 'normal' }
      );
      await this.env.JOBS_QUEUE.send(job);
    }

    return new Response(JSON.stringify({ success: true, action: 'acknowledged' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
