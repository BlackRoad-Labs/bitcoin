/**
 * ⬛⬜🛣️ BlackRoad Agent Types
 * Core type definitions for the Cloudflare Workers Agent System
 */

// Environment bindings
export interface Env {
  // KV Namespaces
  REPO_CACHE: KVNamespace;
  AGENT_STATE: KVNamespace;
  RESOLUTION_LOG: KVNamespace;

  // Durable Objects
  AGENT_COORDINATOR: DurableObjectNamespace;
  JOB_QUEUE: DurableObjectNamespace;
  REPO_WATCHER: DurableObjectNamespace;
  SELF_HEALER: DurableObjectNamespace;

  // Queues
  JOBS_QUEUE: Queue<AgentJob>;
  DLQ_QUEUE: Queue<AgentJob>;

  // R2
  ARTIFACTS: R2Bucket;

  // Environment variables
  ENVIRONMENT: string;
  GITHUB_ORG: string;
  PRIMARY_REPOS: string;
  GITHUB_TOKEN?: string;
}

// Job system types
export type JobType =
  | 'SCRAPE_REPO'
  | 'ANALYZE_COHESIVENESS'
  | 'SYNC_REPOS'
  | 'SELF_HEAL'
  | 'UPDATE_CHECK'
  | 'WEBHOOK_DISPATCH'
  | 'ARTIFACT_CLEANUP'
  | 'HEALTH_CHECK';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'retrying';

export type JobPriority = 'critical' | 'high' | 'normal' | 'low';

export interface AgentJob {
  id: string;
  type: JobType;
  priority: JobPriority;
  payload: Record<string, unknown>;
  status: JobStatus;
  retries: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
  scheduledFor?: number;
  completedAt?: number;
  error?: string;
  result?: unknown;
  parentJobId?: string;
  childJobIds?: string[];
}

// Repository types
export interface RepoMetadata {
  org: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  lastScrapedAt?: number;
  lastCommitSha?: string;
  lastCommitDate?: string;
  fileCount: number;
  languages: Record<string, number>;
  dependencies: DependencyInfo[];
  configFiles: string[];
  hasWorkflows: boolean;
  healthScore: number;
}

export interface DependencyInfo {
  name: string;
  version: string;
  type: 'runtime' | 'dev' | 'peer' | 'optional';
  source: 'npm' | 'pip' | 'cargo' | 'go' | 'other';
}

export interface RepoFile {
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir';
  content?: string;
  encoding?: string;
}

export interface ScrapedRepo {
  metadata: RepoMetadata;
  structure: RepoFile[];
  readme?: string;
  packageJson?: Record<string, unknown>;
  workflows?: WorkflowInfo[];
  scrapedAt: number;
}

export interface WorkflowInfo {
  name: string;
  path: string;
  triggers: string[];
  jobs: string[];
}

// Cohesiveness types
export interface CohesivenessReport {
  id: string;
  generatedAt: number;
  repos: string[];
  overallScore: number;
  metrics: CohesivenessMetrics;
  issues: CohesivenessIssue[];
  recommendations: Recommendation[];
}

export interface CohesivenessMetrics {
  dependencyAlignment: number;
  configConsistency: number;
  namingConventions: number;
  workflowAlignment: number;
  documentationCoverage: number;
  versionSync: number;
}

export interface CohesivenessIssue {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  category: string;
  description: string;
  affectedRepos: string[];
  suggestedFix?: string;
  autoFixable: boolean;
}

export interface Recommendation {
  id: string;
  priority: number;
  title: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  effort: 'high' | 'medium' | 'low';
  repos: string[];
}

// Self-resolution types
export interface ResolutionAction {
  id: string;
  type: ResolutionType;
  triggeredBy: string;
  triggeredAt: number;
  status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'rolled_back';
  context: Record<string, unknown>;
  steps: ResolutionStep[];
  rollbackSteps?: ResolutionStep[];
}

export type ResolutionType =
  | 'RETRY_JOB'
  | 'RESTART_AGENT'
  | 'CLEAR_CACHE'
  | 'REFRESH_TOKEN'
  | 'FALLBACK_SOURCE'
  | 'SCALE_DOWN'
  | 'ALERT_HUMAN'
  | 'AUTO_FIX';

export interface ResolutionStep {
  id: string;
  action: string;
  params: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: number;
  completedAt?: number;
  output?: unknown;
  error?: string;
}

// Health check types
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  components: ComponentHealth[];
  activeJobs: number;
  failedJobsLast24h: number;
  lastSuccessfulScrape?: number;
  uptime: number;
}

export interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  lastCheck: number;
  message?: string;
}

// Agent coordination types
export interface AgentState {
  id: string;
  type: AgentType;
  status: 'idle' | 'working' | 'paused' | 'error';
  currentJob?: string;
  lastHeartbeat: number;
  metrics: AgentMetrics;
}

export type AgentType = 'coordinator' | 'scraper' | 'analyzer' | 'healer' | 'watcher';

export interface AgentMetrics {
  jobsProcessed: number;
  jobsFailed: number;
  avgProcessingTime: number;
  lastJobDuration?: number;
  memoryUsage?: number;
}

// Webhook types
export interface WebhookPayload {
  event: string;
  action?: string;
  repository?: {
    full_name: string;
    default_branch: string;
  };
  sender?: {
    login: string;
  };
  commits?: Array<{
    id: string;
    message: string;
    timestamp: string;
  }>;
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}
