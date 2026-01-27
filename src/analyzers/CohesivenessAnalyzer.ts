/**
 * ⬛⬜🛣️ Cohesiveness Analyzer
 * Analyzes consistency and alignment across multiple repositories
 */

import type {
  Env,
  ScrapedRepo,
  CohesivenessReport,
  CohesivenessMetrics,
  CohesivenessIssue,
  Recommendation,
  DependencyInfo,
} from '../types';
import { generateId } from '../utils/helpers';
import { GitHubScraper } from '../scrapers/GitHubScraper';

interface DependencyConflict {
  name: string;
  versions: Map<string, string[]>; // version -> repos using it
}

interface ConfigDifference {
  configFile: string;
  repos: string[];
  differences: string[];
}

export class CohesivenessAnalyzer {
  private env: Env;
  private scraper: GitHubScraper;

  constructor(env: Env) {
    this.env = env;
    this.scraper = new GitHubScraper(env);
  }

  async analyzeRepos(org: string, repoNames: string[]): Promise<CohesivenessReport> {
    console.log(`Analyzing cohesiveness for ${repoNames.length} repos in ${org}`);

    // Fetch or use cached repo data
    const repos: Map<string, ScrapedRepo> = new Map();

    for (const repoName of repoNames) {
      const fullName = `${org}/${repoName}`;
      let repoData = await this.scraper.getCachedRepo(fullName);

      if (!repoData) {
        try {
          repoData = await this.scraper.scrapeRepo(org, repoName);
        } catch (error) {
          console.error(`Failed to scrape ${fullName}:`, error);
          continue;
        }
      }

      repos.set(fullName, repoData);
    }

    if (repos.size < 2) {
      throw new Error('Need at least 2 repos for cohesiveness analysis');
    }

    // Analyze various aspects
    const dependencyAlignment = this.analyzeDependencyAlignment(repos);
    const configConsistency = this.analyzeConfigConsistency(repos);
    const namingConventions = this.analyzeNamingConventions(repos);
    const workflowAlignment = this.analyzeWorkflowAlignment(repos);
    const documentationCoverage = this.analyzeDocumentationCoverage(repos);
    const versionSync = this.analyzeVersionSync(repos);

    // Collect all issues
    const issues: CohesivenessIssue[] = [
      ...dependencyAlignment.issues,
      ...configConsistency.issues,
      ...namingConventions.issues,
      ...workflowAlignment.issues,
      ...documentationCoverage.issues,
      ...versionSync.issues,
    ];

    // Generate recommendations
    const recommendations = this.generateRecommendations(issues, repos);

    // Calculate overall score
    const metrics: CohesivenessMetrics = {
      dependencyAlignment: dependencyAlignment.score,
      configConsistency: configConsistency.score,
      namingConventions: namingConventions.score,
      workflowAlignment: workflowAlignment.score,
      documentationCoverage: documentationCoverage.score,
      versionSync: versionSync.score,
    };

    const overallScore = Math.round(
      (metrics.dependencyAlignment +
        metrics.configConsistency +
        metrics.namingConventions +
        metrics.workflowAlignment +
        metrics.documentationCoverage +
        metrics.versionSync) /
        6
    );

    const report: CohesivenessReport = {
      id: generateId('report'),
      generatedAt: Date.now(),
      repos: Array.from(repos.keys()),
      overallScore,
      metrics,
      issues: issues.sort((a, b) => {
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      }),
      recommendations: recommendations.sort((a, b) => a.priority - b.priority),
    };

    // Cache the report
    await this.cacheReport(report);

    console.log(`Cohesiveness analysis complete: score ${overallScore}/100, ${issues.length} issues`);

    return report;
  }

  private analyzeDependencyAlignment(
    repos: Map<string, ScrapedRepo>
  ): { score: number; issues: CohesivenessIssue[] } {
    const issues: CohesivenessIssue[] = [];
    const dependencyVersions = new Map<string, Map<string, string[]>>();

    // Collect all dependency versions across repos
    for (const [repoName, repoData] of repos) {
      for (const dep of repoData.metadata.dependencies) {
        if (!dependencyVersions.has(dep.name)) {
          dependencyVersions.set(dep.name, new Map());
        }
        const versions = dependencyVersions.get(dep.name)!;
        if (!versions.has(dep.version)) {
          versions.set(dep.version, []);
        }
        versions.get(dep.version)!.push(repoName);
      }
    }

    // Find version conflicts
    let conflictCount = 0;
    for (const [depName, versions] of dependencyVersions) {
      if (versions.size > 1) {
        conflictCount++;
        const versionList = Array.from(versions.entries())
          .map(([v, repos]) => `${v} (${repos.length} repos)`)
          .join(', ');

        issues.push({
          id: generateId('issue'),
          severity: 'warning',
          category: 'dependency',
          description: `Dependency "${depName}" has multiple versions: ${versionList}`,
          affectedRepos: Array.from(versions.values()).flat(),
          suggestedFix: `Align all repos to use the same version of ${depName}`,
          autoFixable: true,
        });
      }
    }

    // Calculate score
    const totalDeps = dependencyVersions.size;
    const score = totalDeps > 0 ? Math.round(((totalDeps - conflictCount) / totalDeps) * 100) : 100;

    return { score, issues };
  }

  private analyzeConfigConsistency(
    repos: Map<string, ScrapedRepo>
  ): { score: number; issues: CohesivenessIssue[] } {
    const issues: CohesivenessIssue[] = [];
    const configPresence = new Map<string, string[]>();

    // Track which configs exist in which repos
    const standardConfigs = [
      'tsconfig.json',
      '.eslintrc.js',
      '.prettierrc',
      '.editorconfig',
      'jest.config.js',
      '.github/workflows/ci.yml',
    ];

    for (const [repoName, repoData] of repos) {
      for (const config of standardConfigs) {
        const hasConfig = repoData.metadata.configFiles.some(
          (c) => c.includes(config.replace('.js', '').replace('.json', ''))
        );
        if (hasConfig) {
          if (!configPresence.has(config)) {
            configPresence.set(config, []);
          }
          configPresence.get(config)!.push(repoName);
        }
      }
    }

    // Check for inconsistent config presence
    const repoCount = repos.size;
    for (const [config, reposWithConfig] of configPresence) {
      if (reposWithConfig.length > 0 && reposWithConfig.length < repoCount) {
        const reposWithout = Array.from(repos.keys()).filter((r) => !reposWithConfig.includes(r));

        issues.push({
          id: generateId('issue'),
          severity: 'info',
          category: 'config',
          description: `Config "${config}" is present in ${reposWithConfig.length}/${repoCount} repos`,
          affectedRepos: reposWithout,
          suggestedFix: `Add ${config} to repos: ${reposWithout.join(', ')}`,
          autoFixable: false,
        });
      }
    }

    // Calculate score based on consistency
    let consistentConfigs = 0;
    for (const reposWithConfig of configPresence.values()) {
      if (reposWithConfig.length === repoCount || reposWithConfig.length === 0) {
        consistentConfigs++;
      }
    }

    const score =
      configPresence.size > 0 ? Math.round((consistentConfigs / configPresence.size) * 100) : 100;

    return { score, issues };
  }

  private analyzeNamingConventions(
    repos: Map<string, ScrapedRepo>
  ): { score: number; issues: CohesivenessIssue[] } {
    const issues: CohesivenessIssue[] = [];
    let score = 100;

    // Check for consistent directory naming
    const srcDirNames = new Map<string, string[]>();
    const testDirNames = new Map<string, string[]>();

    for (const [repoName, repoData] of repos) {
      const dirs = repoData.structure.filter((f) => f.type === 'dir').map((f) => f.path);

      // Source directories
      const srcDir = dirs.find((d) => ['src', 'lib', 'source', 'app'].includes(d));
      if (srcDir) {
        if (!srcDirNames.has(srcDir)) {
          srcDirNames.set(srcDir, []);
        }
        srcDirNames.get(srcDir)!.push(repoName);
      }

      // Test directories
      const testDir = dirs.find((d) =>
        ['test', 'tests', '__tests__', 'spec', 'specs'].includes(d)
      );
      if (testDir) {
        if (!testDirNames.has(testDir)) {
          testDirNames.set(testDir, []);
        }
        testDirNames.get(testDir)!.push(repoName);
      }
    }

    // Check source directory consistency
    if (srcDirNames.size > 1) {
      score -= 15;
      const variants = Array.from(srcDirNames.entries())
        .map(([name, repos]) => `"${name}" (${repos.length})`)
        .join(', ');

      issues.push({
        id: generateId('issue'),
        severity: 'info',
        category: 'naming',
        description: `Inconsistent source directory naming: ${variants}`,
        affectedRepos: Array.from(repos.keys()),
        suggestedFix: 'Standardize on a single source directory name (e.g., "src")',
        autoFixable: false,
      });
    }

    // Check test directory consistency
    if (testDirNames.size > 1) {
      score -= 10;
      const variants = Array.from(testDirNames.entries())
        .map(([name, repos]) => `"${name}" (${repos.length})`)
        .join(', ');

      issues.push({
        id: generateId('issue'),
        severity: 'info',
        category: 'naming',
        description: `Inconsistent test directory naming: ${variants}`,
        affectedRepos: Array.from(repos.keys()),
        suggestedFix: 'Standardize on a single test directory name',
        autoFixable: false,
      });
    }

    return { score: Math.max(0, score), issues };
  }

  private analyzeWorkflowAlignment(
    repos: Map<string, ScrapedRepo>
  ): { score: number; issues: CohesivenessIssue[] } {
    const issues: CohesivenessIssue[] = [];
    const workflowPresence = new Map<string, string[]>();

    // Standard workflows we expect
    const standardWorkflows = ['ci', 'build', 'test', 'lint', 'deploy'];

    for (const [repoName, repoData] of repos) {
      if (!repoData.workflows) continue;

      for (const workflow of repoData.workflows) {
        const normalizedName = workflow.name.toLowerCase();
        const category =
          standardWorkflows.find((w) => normalizedName.includes(w)) || 'other';

        if (!workflowPresence.has(category)) {
          workflowPresence.set(category, []);
        }
        workflowPresence.get(category)!.push(repoName);
      }
    }

    // Check for repos without CI
    const reposWithCi = new Set([
      ...(workflowPresence.get('ci') || []),
      ...(workflowPresence.get('build') || []),
      ...(workflowPresence.get('test') || []),
    ]);

    const reposWithoutCi = Array.from(repos.keys()).filter((r) => !reposWithCi.has(r));

    if (reposWithoutCi.length > 0) {
      issues.push({
        id: generateId('issue'),
        severity: 'warning',
        category: 'workflow',
        description: `${reposWithoutCi.length} repos lack CI/CD workflows`,
        affectedRepos: reposWithoutCi,
        suggestedFix: 'Add GitHub Actions workflows for CI/CD',
        autoFixable: false,
      });
    }

    // Calculate score
    const score = repos.size > 0 ? Math.round((reposWithCi.size / repos.size) * 100) : 100;

    return { score, issues };
  }

  private analyzeDocumentationCoverage(
    repos: Map<string, ScrapedRepo>
  ): { score: number; issues: CohesivenessIssue[] } {
    const issues: CohesivenessIssue[] = [];
    let totalScore = 0;

    for (const [repoName, repoData] of repos) {
      let repoScore = 0;

      // README
      if (repoData.readme) {
        repoScore += 40;
        // Check README quality
        if (repoData.readme.length > 500) repoScore += 10;
        if (repoData.readme.includes('##')) repoScore += 5; // Has sections
        if (repoData.readme.includes('```')) repoScore += 5; // Has code examples
      } else {
        issues.push({
          id: generateId('issue'),
          severity: 'warning',
          category: 'documentation',
          description: `Repository "${repoName}" lacks a README`,
          affectedRepos: [repoName],
          suggestedFix: 'Add a README.md with project description and usage instructions',
          autoFixable: false,
        });
      }

      // Contributing guide
      const hasContributing = repoData.structure.some((f) =>
        f.path.toLowerCase().includes('contributing')
      );
      if (hasContributing) repoScore += 15;

      // License
      const hasLicense = repoData.structure.some((f) =>
        f.path.toLowerCase().includes('license')
      );
      if (hasLicense) repoScore += 15;

      // Changelog
      const hasChangelog = repoData.structure.some((f) =>
        f.path.toLowerCase().includes('changelog')
      );
      if (hasChangelog) repoScore += 10;

      totalScore += repoScore;
    }

    const score = repos.size > 0 ? Math.round(totalScore / repos.size) : 100;

    return { score, issues };
  }

  private analyzeVersionSync(
    repos: Map<string, ScrapedRepo>
  ): { score: number; issues: CohesivenessIssue[] } {
    const issues: CohesivenessIssue[] = [];
    const majorVersions = new Map<string, Map<number, string[]>>();

    // Check TypeScript versions
    for (const [repoName, repoData] of repos) {
      const tsDep = repoData.metadata.dependencies.find(
        (d) => d.name === 'typescript' && d.source === 'npm'
      );

      if (tsDep) {
        const majorMatch = tsDep.version.match(/\d+/);
        if (majorMatch) {
          const major = parseInt(majorMatch[0], 10);
          if (!majorVersions.has('typescript')) {
            majorVersions.set('typescript', new Map());
          }
          const tsVersions = majorVersions.get('typescript')!;
          if (!tsVersions.has(major)) {
            tsVersions.set(major, []);
          }
          tsVersions.get(major)!.push(repoName);
        }
      }
    }

    // Check Node.js/engine requirements
    for (const [repoName, repoData] of repos) {
      if (repoData.packageJson?.engines) {
        const engines = repoData.packageJson.engines as Record<string, string>;
        if (engines.node) {
          const majorMatch = engines.node.match(/\d+/);
          if (majorMatch) {
            const major = parseInt(majorMatch[0], 10);
            if (!majorVersions.has('node')) {
              majorVersions.set('node', new Map());
            }
            const nodeVersions = majorVersions.get('node')!;
            if (!nodeVersions.has(major)) {
              nodeVersions.set(major, []);
            }
            nodeVersions.get(major)!.push(repoName);
          }
        }
      }
    }

    // Check for version misalignment
    let alignedCount = 0;
    for (const [toolName, versions] of majorVersions) {
      if (versions.size > 1) {
        const versionList = Array.from(versions.entries())
          .map(([v, repos]) => `v${v} (${repos.length} repos)`)
          .join(', ');

        issues.push({
          id: generateId('issue'),
          severity: 'warning',
          category: 'version',
          description: `${toolName} major version mismatch: ${versionList}`,
          affectedRepos: Array.from(versions.values()).flat(),
          suggestedFix: `Upgrade all repos to the same major version of ${toolName}`,
          autoFixable: false,
        });
      } else {
        alignedCount++;
      }
    }

    const score =
      majorVersions.size > 0 ? Math.round((alignedCount / majorVersions.size) * 100) : 100;

    return { score, issues };
  }

  private generateRecommendations(
    issues: CohesivenessIssue[],
    repos: Map<string, ScrapedRepo>
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];
    let priority = 1;

    // Group issues by category
    const issuesByCategory = new Map<string, CohesivenessIssue[]>();
    for (const issue of issues) {
      if (!issuesByCategory.has(issue.category)) {
        issuesByCategory.set(issue.category, []);
      }
      issuesByCategory.get(issue.category)!.push(issue);
    }

    // Generate recommendations based on issue patterns
    const criticalIssues = issues.filter((i) => i.severity === 'critical');
    if (criticalIssues.length > 0) {
      recommendations.push({
        id: generateId('rec'),
        priority: priority++,
        title: 'Address Critical Issues Immediately',
        description: `There are ${criticalIssues.length} critical issues that need immediate attention. These may affect stability or security.`,
        impact: 'high',
        effort: 'medium',
        repos: [...new Set(criticalIssues.flatMap((i) => i.affectedRepos))],
      });
    }

    // Dependency recommendations
    const depIssues = issuesByCategory.get('dependency') || [];
    if (depIssues.length > 3) {
      recommendations.push({
        id: generateId('rec'),
        priority: priority++,
        title: 'Implement Shared Dependency Management',
        description:
          'Consider using a monorepo or shared dependency configuration to keep package versions aligned across repositories.',
        impact: 'high',
        effort: 'high',
        repos: Array.from(repos.keys()),
      });
    }

    // Config recommendations
    const configIssues = issuesByCategory.get('config') || [];
    if (configIssues.length > 0) {
      recommendations.push({
        id: generateId('rec'),
        priority: priority++,
        title: 'Standardize Configuration Files',
        description:
          'Create shared configuration templates for ESLint, TypeScript, and other tools. Consider publishing an internal config package.',
        impact: 'medium',
        effort: 'medium',
        repos: Array.from(repos.keys()),
      });
    }

    // CI/CD recommendations
    const workflowIssues = issuesByCategory.get('workflow') || [];
    if (workflowIssues.length > 0) {
      recommendations.push({
        id: generateId('rec'),
        priority: priority++,
        title: 'Implement Consistent CI/CD Pipelines',
        description:
          'Use reusable GitHub Actions workflows to ensure consistent CI/CD across all repositories.',
        impact: 'high',
        effort: 'medium',
        repos: workflowIssues.flatMap((i) => i.affectedRepos),
      });
    }

    // Documentation recommendations
    const docIssues = issuesByCategory.get('documentation') || [];
    if (docIssues.length > 0) {
      recommendations.push({
        id: generateId('rec'),
        priority: priority++,
        title: 'Improve Documentation Coverage',
        description:
          'Create README templates and documentation standards. Ensure all repos have basic documentation.',
        impact: 'medium',
        effort: 'low',
        repos: docIssues.flatMap((i) => i.affectedRepos),
      });
    }

    // Auto-fixable recommendations
    const autoFixableIssues = issues.filter((i) => i.autoFixable);
    if (autoFixableIssues.length > 0) {
      recommendations.push({
        id: generateId('rec'),
        priority: priority++,
        title: 'Run Automated Fixes',
        description: `${autoFixableIssues.length} issues can be automatically fixed. Consider running the auto-fix tool.`,
        impact: 'medium',
        effort: 'low',
        repos: [...new Set(autoFixableIssues.flatMap((i) => i.affectedRepos))],
      });
    }

    return recommendations;
  }

  private async cacheReport(report: CohesivenessReport): Promise<void> {
    // Cache in KV
    await this.env.REPO_CACHE.put(`cohesiveness:latest`, JSON.stringify(report), {
      expirationTtl: 86400 * 7, // 7 days
    });

    // Store in R2 for history
    await this.env.ARTIFACTS.put(
      `reports/cohesiveness/${report.id}.json`,
      JSON.stringify(report),
      {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          generatedAt: String(report.generatedAt),
          repoCount: String(report.repos.length),
          overallScore: String(report.overallScore),
        },
      }
    );
  }

  async getLatestReport(): Promise<CohesivenessReport | null> {
    const cached = await this.env.REPO_CACHE.get('cohesiveness:latest');
    if (cached) {
      return JSON.parse(cached);
    }
    return null;
  }
}
