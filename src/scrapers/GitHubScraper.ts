/**
 * ⬛⬜🛣️ GitHub Repository Scraper
 * Scrapes repositories for structure, dependencies, and metadata
 */

import type {
  Env,
  RepoMetadata,
  ScrapedRepo,
  RepoFile,
  DependencyInfo,
  WorkflowInfo,
} from '../types';
import { withRetry } from '../utils/helpers';

interface GitHubTreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
  url?: string;
}

interface GitHubTreeResponse {
  sha: string;
  url: string;
  tree: GitHubTreeItem[];
  truncated: boolean;
}

interface GitHubRepoResponse {
  name: string;
  full_name: string;
  default_branch: string;
  language: string;
  languages_url: string;
  size: number;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string;
  updated_at: string;
}

export class GitHubScraper {
  private env: Env;
  private headers: HeadersInit;

  constructor(env: Env) {
    this.env = env;
    this.headers = {
      'User-Agent': 'BlackRoad-Agent/1.0',
      Accept: 'application/vnd.github.v3+json',
    };

    if (env.GITHUB_TOKEN) {
      this.headers['Authorization'] = `token ${env.GITHUB_TOKEN}`;
    }
  }

  async scrapeRepo(org: string, repoName: string): Promise<ScrapedRepo> {
    const fullName = `${org}/${repoName}`;
    console.log(`Scraping repository: ${fullName}`);

    // Fetch repo metadata
    const repoInfo = await this.fetchRepoInfo(org, repoName);

    // Fetch file tree
    const tree = await this.fetchFileTree(org, repoName, repoInfo.default_branch);

    // Fetch languages
    const languages = await this.fetchLanguages(org, repoName);

    // Parse dependencies from package.json, requirements.txt, etc.
    const dependencies = await this.extractDependencies(org, repoName, tree);

    // Extract workflow info
    const workflows = await this.extractWorkflows(org, repoName, tree);

    // Fetch README
    const readme = await this.fetchReadme(org, repoName);

    // Fetch package.json if exists
    const packageJson = await this.fetchPackageJson(org, repoName);

    // Identify config files
    const configFiles = this.identifyConfigFiles(tree);

    // Calculate health score
    const healthScore = this.calculateHealthScore({
      hasReadme: !!readme,
      hasWorkflows: workflows.length > 0,
      hasTests: tree.some((f) => f.path.includes('test') || f.path.includes('spec')),
      hasCi: workflows.some((w) => w.triggers.includes('push') || w.triggers.includes('pull_request')),
      hasLicense: tree.some((f) => f.path.toLowerCase().includes('license')),
      hasContributing: tree.some((f) => f.path.toLowerCase().includes('contributing')),
      dependencyCount: dependencies.length,
      fileCount: tree.filter((f) => f.type === 'file').length,
    });

    const metadata: RepoMetadata = {
      org,
      name: repoName,
      fullName,
      defaultBranch: repoInfo.default_branch,
      lastScrapedAt: Date.now(),
      lastCommitSha: tree.length > 0 ? tree[0].sha : undefined,
      fileCount: tree.filter((f) => f.type === 'file').length,
      languages,
      dependencies,
      configFiles,
      hasWorkflows: workflows.length > 0,
      healthScore,
    };

    const scrapedRepo: ScrapedRepo = {
      metadata,
      structure: tree,
      readme,
      packageJson,
      workflows,
      scrapedAt: Date.now(),
    };

    // Cache the result
    await this.cacheScrapedRepo(fullName, scrapedRepo);

    console.log(`Scraped ${fullName}: ${tree.length} files, ${dependencies.length} deps, score: ${healthScore}`);

    return scrapedRepo;
  }

  private async fetchRepoInfo(org: string, repo: string): Promise<GitHubRepoResponse> {
    return withRetry(
      async () => {
        const response = await fetch(`https://api.github.com/repos/${org}/${repo}`, {
          headers: this.headers,
        });

        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        return response.json();
      },
      { maxRetries: 3 }
    );
  }

  private async fetchFileTree(org: string, repo: string, branch: string): Promise<RepoFile[]> {
    return withRetry(
      async () => {
        const response = await fetch(
          `https://api.github.com/repos/${org}/${repo}/git/trees/${branch}?recursive=1`,
          { headers: this.headers }
        );

        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status}`);
        }

        const data: GitHubTreeResponse = await response.json();

        return data.tree.map((item) => ({
          path: item.path,
          sha: item.sha,
          size: item.size || 0,
          type: item.type === 'blob' ? 'file' : 'dir',
        }));
      },
      { maxRetries: 3 }
    );
  }

  private async fetchLanguages(org: string, repo: string): Promise<Record<string, number>> {
    return withRetry(
      async () => {
        const response = await fetch(`https://api.github.com/repos/${org}/${repo}/languages`, {
          headers: this.headers,
        });

        if (!response.ok) {
          return {};
        }

        return response.json();
      },
      { maxRetries: 2 }
    );
  }

  private async extractDependencies(
    org: string,
    repo: string,
    tree: RepoFile[]
  ): Promise<DependencyInfo[]> {
    const dependencies: DependencyInfo[] = [];

    // Check for package.json (npm)
    if (tree.some((f) => f.path === 'package.json')) {
      const packageJson = await this.fetchFileContent(org, repo, 'package.json');
      if (packageJson) {
        try {
          const pkg = JSON.parse(packageJson);
          if (pkg.dependencies) {
            for (const [name, version] of Object.entries(pkg.dependencies)) {
              dependencies.push({
                name,
                version: String(version),
                type: 'runtime',
                source: 'npm',
              });
            }
          }
          if (pkg.devDependencies) {
            for (const [name, version] of Object.entries(pkg.devDependencies)) {
              dependencies.push({
                name,
                version: String(version),
                type: 'dev',
                source: 'npm',
              });
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Check for requirements.txt (pip)
    if (tree.some((f) => f.path === 'requirements.txt' || f.path.endsWith('/requirements.txt'))) {
      const requirements = await this.fetchFileContent(org, repo, 'requirements.txt');
      if (requirements) {
        const lines = requirements.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
        for (const line of lines) {
          const match = line.match(/^([a-zA-Z0-9_-]+)([<>=!]+.*)?$/);
          if (match) {
            dependencies.push({
              name: match[1],
              version: match[2] || '*',
              type: 'runtime',
              source: 'pip',
            });
          }
        }
      }
    }

    // Check for Cargo.toml (Rust)
    if (tree.some((f) => f.path === 'Cargo.toml')) {
      const cargoToml = await this.fetchFileContent(org, repo, 'Cargo.toml');
      if (cargoToml) {
        // Simple parsing - a full TOML parser would be better
        const depsMatch = cargoToml.match(/\[dependencies\]([\s\S]*?)(?=\[|$)/);
        if (depsMatch) {
          const depsSection = depsMatch[1];
          const depLines = depsSection.split('\n').filter((l) => l.includes('='));
          for (const line of depLines) {
            const match = line.match(/^([a-zA-Z0-9_-]+)\s*=/);
            if (match) {
              dependencies.push({
                name: match[1],
                version: '*',
                type: 'runtime',
                source: 'cargo',
              });
            }
          }
        }
      }
    }

    // Check for go.mod (Go)
    if (tree.some((f) => f.path === 'go.mod')) {
      const goMod = await this.fetchFileContent(org, repo, 'go.mod');
      if (goMod) {
        const requireMatch = goMod.match(/require\s*\(([\s\S]*?)\)/);
        if (requireMatch) {
          const lines = requireMatch[1].split('\n').filter((l) => l.trim());
          for (const line of lines) {
            const match = line.trim().match(/^([^\s]+)\s+([^\s]+)/);
            if (match) {
              dependencies.push({
                name: match[1],
                version: match[2],
                type: 'runtime',
                source: 'go',
              });
            }
          }
        }
      }
    }

    return dependencies;
  }

  private async extractWorkflows(
    org: string,
    repo: string,
    tree: RepoFile[]
  ): Promise<WorkflowInfo[]> {
    const workflows: WorkflowInfo[] = [];
    const workflowFiles = tree.filter(
      (f) => f.path.startsWith('.github/workflows/') && f.path.endsWith('.yml')
    );

    for (const file of workflowFiles.slice(0, 10)) {
      // Limit to 10 workflows
      const content = await this.fetchFileContent(org, repo, file.path);
      if (content) {
        const workflow = this.parseWorkflowYaml(file.path, content);
        if (workflow) {
          workflows.push(workflow);
        }
      }
    }

    return workflows;
  }

  private parseWorkflowYaml(path: string, content: string): WorkflowInfo | null {
    try {
      // Simple YAML parsing for workflow files
      const nameMatch = content.match(/^name:\s*['"]?([^'"\n]+)['"]?/m);
      const name = nameMatch ? nameMatch[1] : path.split('/').pop()?.replace('.yml', '') || 'unknown';

      // Extract triggers
      const triggers: string[] = [];
      const onMatch = content.match(/^on:\s*\n([\s\S]*?)(?=^[a-z]|\n\n|$)/m);
      if (onMatch) {
        const triggerSection = onMatch[1];
        const triggerMatches = triggerSection.match(/^\s+([a-z_]+):/gm);
        if (triggerMatches) {
          for (const t of triggerMatches) {
            triggers.push(t.trim().replace(':', ''));
          }
        }
      } else {
        // Single-line on:
        const singleOnMatch = content.match(/^on:\s*\[?([^\]\n]+)\]?/m);
        if (singleOnMatch) {
          triggers.push(...singleOnMatch[1].split(',').map((t) => t.trim()));
        }
      }

      // Extract job names
      const jobs: string[] = [];
      const jobsMatch = content.match(/^jobs:\s*\n([\s\S]*?)(?=^[a-z]|$)/m);
      if (jobsMatch) {
        const jobMatches = jobsMatch[1].match(/^\s{2}([a-zA-Z0-9_-]+):/gm);
        if (jobMatches) {
          for (const j of jobMatches) {
            jobs.push(j.trim().replace(':', ''));
          }
        }
      }

      return { name, path, triggers, jobs };
    } catch {
      return null;
    }
  }

  private async fetchReadme(org: string, repo: string): Promise<string | undefined> {
    const readmeNames = ['README.md', 'readme.md', 'Readme.md', 'README'];
    for (const name of readmeNames) {
      const content = await this.fetchFileContent(org, repo, name);
      if (content) return content;
    }
    return undefined;
  }

  private async fetchPackageJson(org: string, repo: string): Promise<Record<string, unknown> | undefined> {
    const content = await this.fetchFileContent(org, repo, 'package.json');
    if (content) {
      try {
        return JSON.parse(content);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async fetchFileContent(org: string, repo: string, path: string): Promise<string | null> {
    try {
      const response = await fetch(`https://api.github.com/repos/${org}/${repo}/contents/${path}`, {
        headers: this.headers,
      });

      if (!response.ok) return null;

      const data = await response.json<{ content?: string; encoding?: string }>();

      if (data.content && data.encoding === 'base64') {
        return atob(data.content);
      }

      return null;
    } catch {
      return null;
    }
  }

  private identifyConfigFiles(tree: RepoFile[]): string[] {
    const configPatterns = [
      /^\.?eslintrc/,
      /^\.?prettierrc/,
      /^tsconfig/,
      /^jest\.config/,
      /^vitest\.config/,
      /^\.?babelrc/,
      /^webpack\.config/,
      /^rollup\.config/,
      /^vite\.config/,
      /^wrangler\.toml$/,
      /^Dockerfile$/,
      /^docker-compose/,
      /^\.github\//,
      /^\.env\.example$/,
      /^Makefile$/,
      /^\.editorconfig$/,
      /^\.gitignore$/,
    ];

    return tree
      .filter((f) => f.type === 'file' && configPatterns.some((p) => p.test(f.path)))
      .map((f) => f.path)
      .slice(0, 50);
  }

  private calculateHealthScore(metrics: {
    hasReadme: boolean;
    hasWorkflows: boolean;
    hasTests: boolean;
    hasCi: boolean;
    hasLicense: boolean;
    hasContributing: boolean;
    dependencyCount: number;
    fileCount: number;
  }): number {
    let score = 0;
    const maxScore = 100;

    // Documentation (30 points)
    if (metrics.hasReadme) score += 20;
    if (metrics.hasContributing) score += 5;
    if (metrics.hasLicense) score += 5;

    // CI/CD (25 points)
    if (metrics.hasWorkflows) score += 15;
    if (metrics.hasCi) score += 10;

    // Testing (20 points)
    if (metrics.hasTests) score += 20;

    // Project structure (25 points)
    if (metrics.fileCount > 0) score += 10;
    if (metrics.dependencyCount > 0 && metrics.dependencyCount < 100) score += 10;
    if (metrics.fileCount > 5 && metrics.fileCount < 1000) score += 5;

    return Math.min(score, maxScore);
  }

  private async cacheScrapedRepo(fullName: string, data: ScrapedRepo): Promise<void> {
    // Cache in KV
    await this.env.REPO_CACHE.put(`repo:${fullName}`, JSON.stringify(data), {
      expirationTtl: 86400, // 24 hours
    });

    // Store artifacts in R2 for longer retention
    await this.env.ARTIFACTS.put(
      `repos/${fullName.replace('/', '_')}/latest.json`,
      JSON.stringify(data),
      {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { scrapedAt: String(data.scrapedAt) },
      }
    );

    // Also store a timestamped version for history
    await this.env.ARTIFACTS.put(
      `repos/${fullName.replace('/', '_')}/${data.scrapedAt}.json`,
      JSON.stringify(data),
      {
        httpMetadata: { contentType: 'application/json' },
      }
    );
  }

  async getCachedRepo(fullName: string): Promise<ScrapedRepo | null> {
    const cached = await this.env.REPO_CACHE.get(`repo:${fullName}`);
    if (cached) {
      return JSON.parse(cached);
    }
    return null;
  }

  async scrapeMultipleRepos(
    org: string,
    repoNames: string[]
  ): Promise<Map<string, ScrapedRepo | Error>> {
    const results = new Map<string, ScrapedRepo | Error>();

    // Process in parallel with concurrency limit
    const concurrencyLimit = 3;
    const chunks: string[][] = [];

    for (let i = 0; i < repoNames.length; i += concurrencyLimit) {
      chunks.push(repoNames.slice(i, i + concurrencyLimit));
    }

    for (const chunk of chunks) {
      const promises = chunk.map(async (repo) => {
        try {
          const result = await this.scrapeRepo(org, repo);
          results.set(`${org}/${repo}`, result);
        } catch (error) {
          results.set(`${org}/${repo}`, error instanceof Error ? error : new Error(String(error)));
        }
      });

      await Promise.all(promises);
    }

    return results;
  }
}
