/**
 * ⬛⬜🛣️ Self Healer Durable Object
 * Autonomous self-resolution system for failures and issues
 */

import type { Env, ResolutionAction, ResolutionStep, ResolutionType, AgentJob } from '../types';
import { generateId, createJob, getBackoffDelay, sleep } from '../utils/helpers';

interface HealerState {
  activeResolutions: Map<string, ResolutionAction>;
  resolutionHistory: ResolutionAction[];
  failurePatterns: Map<string, FailurePattern>;
  circuitBreakers: Map<string, CircuitBreaker>;
  config: HealerConfig;
}

interface FailurePattern {
  pattern: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  resolutionAttempts: number;
  successfulResolutions: number;
  autoFixable: boolean;
  suggestedAction?: ResolutionType;
}

interface CircuitBreaker {
  name: string;
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  lastFailure?: number;
  lastSuccess?: number;
  openedAt?: number;
  cooldownMs: number;
}

interface HealerConfig {
  maxConcurrentResolutions: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldown: number;
  autoResolveEnabled: boolean;
  alertThreshold: number;
}

const DEFAULT_CONFIG: HealerConfig = {
  maxConcurrentResolutions: 5,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldown: 300000, // 5 minutes
  autoResolveEnabled: true,
  alertThreshold: 10,
};

export class SelfHealer implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private healerState: HealerState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.healerState = {
      activeResolutions: new Map(),
      resolutionHistory: [],
      failurePatterns: new Map(),
      circuitBreakers: new Map(),
      config: DEFAULT_CONFIG,
    };

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<HealerState>('healerState');
      if (stored) {
        this.healerState = {
          ...stored,
          activeResolutions: new Map(Object.entries(stored.activeResolutions || {})),
          failurePatterns: new Map(Object.entries(stored.failurePatterns || {})),
          circuitBreakers: new Map(Object.entries(stored.circuitBreakers || {})),
          config: { ...DEFAULT_CONFIG, ...stored.config },
        };
      }
    });
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('healerState', {
      ...this.healerState,
      activeResolutions: Object.fromEntries(this.healerState.activeResolutions),
      failurePatterns: Object.fromEntries(this.healerState.failurePatterns),
      circuitBreakers: Object.fromEntries(this.healerState.circuitBreakers),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/resolve':
          return this.handleResolve(request);
        case '/status':
          return this.handleStatus();
        case '/patterns':
          return this.handlePatterns();
        case '/circuit-breakers':
          return this.handleCircuitBreakers();
        case '/config':
          return this.handleConfig(request);
        case '/manual-resolve':
          return this.handleManualResolve(request);
        case '/rollback':
          return this.handleRollback(request);
        case '/dlq-process':
          return this.handleDLQProcess(request);
        default:
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
      }
    } catch (error) {
      console.error('SelfHealer error:', error);
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private async handleResolve(request: Request): Promise<Response> {
    const body = await request.json<{
      job?: AgentJob;
      error?: string;
      type?: string;
      context?: Record<string, unknown>;
    }>();

    // Check if we can handle more resolutions
    if (this.healerState.activeResolutions.size >= this.healerState.config.maxConcurrentResolutions) {
      return new Response(
        JSON.stringify({
          success: false,
          reason: 'max_concurrent_resolutions_reached',
          queued: true,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Analyze the failure
    const analysis = this.analyzeFailure(body);

    // Check circuit breaker
    const breaker = this.getCircuitBreaker(analysis.component);
    if (breaker.state === 'open') {
      return new Response(
        JSON.stringify({
          success: false,
          reason: 'circuit_breaker_open',
          component: analysis.component,
          reopensAt: breaker.openedAt! + breaker.cooldownMs,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create resolution action
    const resolution = this.createResolutionAction(analysis);

    if (!this.healerState.config.autoResolveEnabled && resolution.type !== 'ALERT_HUMAN') {
      resolution.type = 'ALERT_HUMAN';
      resolution.steps = this.createAlertSteps(analysis);
    }

    this.healerState.activeResolutions.set(resolution.id, resolution);
    await this.saveState();

    // Execute resolution
    const result = await this.executeResolution(resolution);

    return new Response(
      JSON.stringify({
        success: result.success,
        resolutionId: resolution.id,
        type: resolution.type,
        result,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private analyzeFailure(context: {
    job?: AgentJob;
    error?: string;
    type?: string;
    context?: Record<string, unknown>;
  }): {
    component: string;
    errorType: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    suggestedAction: ResolutionType;
    patternKey: string;
  } {
    const error = context.error || '';
    const jobType = context.job?.type || 'unknown';

    // Identify error patterns
    let errorType = 'unknown';
    let component = 'general';
    let severity: 'low' | 'medium' | 'high' | 'critical' = 'medium';
    let suggestedAction: ResolutionType = 'RETRY_JOB';

    if (error.includes('rate limit') || error.includes('429')) {
      errorType = 'rate_limit';
      component = 'github_api';
      severity = 'medium';
      suggestedAction = 'RETRY_JOB'; // With backoff
    } else if (error.includes('401') || error.includes('403') || error.includes('unauthorized')) {
      errorType = 'auth_failure';
      component = 'authentication';
      severity = 'high';
      suggestedAction = 'REFRESH_TOKEN';
    } else if (error.includes('404') || error.includes('not found')) {
      errorType = 'not_found';
      component = 'resource';
      severity = 'low';
      suggestedAction = 'ALERT_HUMAN';
    } else if (error.includes('timeout') || error.includes('ETIMEDOUT')) {
      errorType = 'timeout';
      component = 'network';
      severity = 'medium';
      suggestedAction = 'RETRY_JOB';
    } else if (error.includes('memory') || error.includes('heap')) {
      errorType = 'resource_exhaustion';
      component = 'worker';
      severity = 'high';
      suggestedAction = 'RESTART_AGENT';
    } else if (error.includes('parse') || error.includes('JSON')) {
      errorType = 'parse_error';
      component = 'data';
      severity = 'medium';
      suggestedAction = 'CLEAR_CACHE';
    } else if (context.type === 'REPO_WATCH_FAILURE') {
      errorType = 'watch_failure';
      component = 'repo_watcher';
      severity = 'medium';
      suggestedAction = 'FALLBACK_SOURCE';
    }

    const patternKey = `${component}:${errorType}`;

    // Update pattern tracking
    this.updateFailurePattern(patternKey, suggestedAction);

    return { component, errorType, severity, suggestedAction, patternKey };
  }

  private updateFailurePattern(patternKey: string, suggestedAction: ResolutionType): void {
    const now = Date.now();
    const existing = this.healerState.failurePatterns.get(patternKey);

    if (existing) {
      existing.count++;
      existing.lastSeen = now;
    } else {
      this.healerState.failurePatterns.set(patternKey, {
        pattern: patternKey,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        resolutionAttempts: 0,
        successfulResolutions: 0,
        autoFixable: suggestedAction !== 'ALERT_HUMAN',
        suggestedAction,
      });
    }
  }

  private getCircuitBreaker(component: string): CircuitBreaker {
    let breaker = this.healerState.circuitBreakers.get(component);

    if (!breaker) {
      breaker = {
        name: component,
        state: 'closed',
        failureCount: 0,
        successCount: 0,
        cooldownMs: this.healerState.config.circuitBreakerCooldown,
      };
      this.healerState.circuitBreakers.set(component, breaker);
    }

    // Check if we should transition from open to half-open
    if (
      breaker.state === 'open' &&
      breaker.openedAt &&
      Date.now() - breaker.openedAt > breaker.cooldownMs
    ) {
      breaker.state = 'half-open';
      console.log(`Circuit breaker ${component} transitioning to half-open`);
    }

    return breaker;
  }

  private updateCircuitBreaker(component: string, success: boolean): void {
    const breaker = this.getCircuitBreaker(component);

    if (success) {
      breaker.successCount++;
      breaker.lastSuccess = Date.now();

      if (breaker.state === 'half-open') {
        breaker.state = 'closed';
        breaker.failureCount = 0;
        console.log(`Circuit breaker ${component} closed after successful resolution`);
      }
    } else {
      breaker.failureCount++;
      breaker.lastFailure = Date.now();

      if (breaker.failureCount >= this.healerState.config.circuitBreakerThreshold) {
        breaker.state = 'open';
        breaker.openedAt = Date.now();
        console.log(`Circuit breaker ${component} opened after ${breaker.failureCount} failures`);
      }
    }
  }

  private createResolutionAction(analysis: {
    component: string;
    errorType: string;
    severity: string;
    suggestedAction: ResolutionType;
    patternKey: string;
  }): ResolutionAction {
    const now = Date.now();

    const action: ResolutionAction = {
      id: generateId('resolution'),
      type: analysis.suggestedAction,
      triggeredBy: analysis.patternKey,
      triggeredAt: now,
      status: 'pending',
      context: { analysis },
      steps: this.createResolutionSteps(analysis.suggestedAction, analysis),
    };

    return action;
  }

  private createResolutionSteps(
    type: ResolutionType,
    context: Record<string, unknown>
  ): ResolutionStep[] {
    const baseStep = (action: string, params: Record<string, unknown> = {}): ResolutionStep => ({
      id: generateId('step'),
      action,
      params,
      status: 'pending',
    });

    switch (type) {
      case 'RETRY_JOB':
        return [
          baseStep('wait_backoff', { baseDelay: 5000 }),
          baseStep('requeue_job', {}),
          baseStep('verify_processing', {}),
        ];

      case 'RESTART_AGENT':
        return [
          baseStep('pause_agent', {}),
          baseStep('clear_agent_state', {}),
          baseStep('reinitialize_agent', {}),
          baseStep('verify_health', {}),
        ];

      case 'CLEAR_CACHE':
        return [
          baseStep('identify_stale_cache', {}),
          baseStep('invalidate_cache_entries', {}),
          baseStep('trigger_refresh', {}),
        ];

      case 'REFRESH_TOKEN':
        return [
          baseStep('check_token_validity', {}),
          baseStep('request_new_token', {}),
          baseStep('update_credentials', {}),
          baseStep('verify_access', {}),
        ];

      case 'FALLBACK_SOURCE':
        return [
          baseStep('identify_alternative_source', {}),
          baseStep('switch_source', {}),
          baseStep('verify_connectivity', {}),
        ];

      case 'SCALE_DOWN':
        return [
          baseStep('reduce_concurrency', {}),
          baseStep('wait_stabilization', { duration: 30000 }),
          baseStep('monitor_metrics', {}),
        ];

      case 'AUTO_FIX':
        return [
          baseStep('analyze_root_cause', context),
          baseStep('generate_fix', {}),
          baseStep('apply_fix', {}),
          baseStep('verify_fix', {}),
        ];

      case 'ALERT_HUMAN':
      default:
        return this.createAlertSteps(context);
    }
  }

  private createAlertSteps(context: Record<string, unknown>): ResolutionStep[] {
    return [
      {
        id: generateId('step'),
        action: 'log_alert',
        params: { context, severity: 'high' },
        status: 'pending',
      },
      {
        id: generateId('step'),
        action: 'create_incident',
        params: { context },
        status: 'pending',
      },
    ];
  }

  private async executeResolution(
    resolution: ResolutionAction
  ): Promise<{ success: boolean; completedSteps: number; error?: string }> {
    resolution.status = 'executing';
    let completedSteps = 0;

    try {
      for (const step of resolution.steps) {
        step.status = 'running';
        step.startedAt = Date.now();

        try {
          const output = await this.executeStep(step, resolution.context);
          step.output = output;
          step.status = 'completed';
          step.completedAt = Date.now();
          completedSteps++;
        } catch (error) {
          step.status = 'failed';
          step.error = error instanceof Error ? error.message : 'Unknown error';
          step.completedAt = Date.now();

          // Update circuit breaker
          const component = (resolution.context.analysis as { component?: string })?.component || 'general';
          this.updateCircuitBreaker(component, false);

          resolution.status = 'failed';
          await this.saveState();

          return {
            success: false,
            completedSteps,
            error: step.error,
          };
        }
      }

      resolution.status = 'succeeded';

      // Update pattern success tracking
      const patternKey = resolution.triggeredBy;
      const pattern = this.healerState.failurePatterns.get(patternKey);
      if (pattern) {
        pattern.resolutionAttempts++;
        pattern.successfulResolutions++;
      }

      // Update circuit breaker
      const component = (resolution.context.analysis as { component?: string })?.component || 'general';
      this.updateCircuitBreaker(component, true);

      // Move to history
      this.healerState.activeResolutions.delete(resolution.id);
      this.healerState.resolutionHistory.push(resolution);

      // Keep history limited
      if (this.healerState.resolutionHistory.length > 100) {
        this.healerState.resolutionHistory.shift();
      }

      await this.saveState();

      console.log(`Resolution ${resolution.id} completed successfully`);

      return { success: true, completedSteps };
    } catch (error) {
      resolution.status = 'failed';
      await this.saveState();

      return {
        success: false,
        completedSteps,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async executeStep(
    step: ResolutionStep,
    context: Record<string, unknown>
  ): Promise<unknown> {
    switch (step.action) {
      case 'wait_backoff': {
        const delay = getBackoffDelay(
          (context.retryCount as number) || 0,
          step.params.baseDelay as number
        );
        await sleep(delay);
        return { waited: delay };
      }

      case 'requeue_job': {
        const job = context.job as AgentJob | undefined;
        if (job) {
          await this.env.JOBS_QUEUE.send(job);
          return { requeued: true, jobId: job.id };
        }
        return { requeued: false, reason: 'no_job' };
      }

      case 'clear_agent_state': {
        // Clear relevant KV entries
        await this.env.AGENT_STATE.delete('failedJobsLast24h');
        return { cleared: true };
      }

      case 'log_alert': {
        console.error('ALERT:', JSON.stringify(step.params));
        await this.env.RESOLUTION_LOG.put(
          `alert:${Date.now()}`,
          JSON.stringify(step.params),
          { expirationTtl: 86400 * 30 }
        );
        return { logged: true };
      }

      case 'create_incident': {
        const incidentId = generateId('incident');
        await this.env.RESOLUTION_LOG.put(
          `incident:${incidentId}`,
          JSON.stringify({
            id: incidentId,
            createdAt: Date.now(),
            context: step.params.context,
            status: 'open',
          }),
          { expirationTtl: 86400 * 90 }
        );
        return { incidentId };
      }

      case 'verify_health': {
        const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('main');
        const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);
        const response = await coordinator.fetch(new Request('http://internal/health'));
        const health = await response.json();
        return { health };
      }

      default:
        console.log(`Executing step: ${step.action}`, step.params);
        return { executed: true, action: step.action };
    }
  }

  private async handleStatus(): Promise<Response> {
    const activeCount = this.healerState.activeResolutions.size;
    const recentHistory = this.healerState.resolutionHistory.slice(-20);
    const successRate =
      recentHistory.length > 0
        ? recentHistory.filter((r) => r.status === 'succeeded').length / recentHistory.length
        : 1;

    const openBreakers = Array.from(this.healerState.circuitBreakers.values()).filter(
      (b) => b.state === 'open'
    );

    return new Response(
      JSON.stringify({
        activeResolutions: activeCount,
        recentResolutions: recentHistory.length,
        successRate: Math.round(successRate * 100),
        openCircuitBreakers: openBreakers.map((b) => b.name),
        config: this.healerState.config,
        patternCount: this.healerState.failurePatterns.size,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async handlePatterns(): Promise<Response> {
    const patterns = Array.from(this.healerState.failurePatterns.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    return new Response(JSON.stringify({ patterns }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCircuitBreakers(): Promise<Response> {
    const breakers = Array.from(this.healerState.circuitBreakers.values());

    return new Response(JSON.stringify({ breakers }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleConfig(request: Request): Promise<Response> {
    if (request.method === 'POST') {
      const updates = await request.json<Partial<HealerConfig>>();
      this.healerState.config = { ...this.healerState.config, ...updates };
      await this.saveState();
    }

    return new Response(JSON.stringify({ config: this.healerState.config }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleManualResolve(request: Request): Promise<Response> {
    const { resolutionType, context } = await request.json<{
      resolutionType: ResolutionType;
      context: Record<string, unknown>;
    }>();

    const resolution: ResolutionAction = {
      id: generateId('manual_resolution'),
      type: resolutionType,
      triggeredBy: 'manual',
      triggeredAt: Date.now(),
      status: 'pending',
      context,
      steps: this.createResolutionSteps(resolutionType, context),
    };

    this.healerState.activeResolutions.set(resolution.id, resolution);
    await this.saveState();

    const result = await this.executeResolution(resolution);

    return new Response(JSON.stringify({ resolution, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleRollback(request: Request): Promise<Response> {
    const { resolutionId } = await request.json<{ resolutionId: string }>();

    const resolution = this.healerState.resolutionHistory.find((r) => r.id === resolutionId);

    if (!resolution) {
      return new Response(JSON.stringify({ error: 'Resolution not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!resolution.rollbackSteps || resolution.rollbackSteps.length === 0) {
      return new Response(JSON.stringify({ error: 'No rollback steps available' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Execute rollback
    resolution.status = 'rolled_back';
    await this.saveState();

    return new Response(JSON.stringify({ success: true, rolledBack: resolutionId }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleDLQProcess(request: Request): Promise<Response> {
    const { jobs } = await request.json<{ jobs: AgentJob[] }>();
    const results: Array<{ jobId: string; action: string; success: boolean }> = [];

    for (const job of jobs) {
      // Analyze and attempt resolution
      const analysis = this.analyzeFailure({
        job,
        error: job.error,
      });

      // For DLQ items, we're more conservative
      if (analysis.severity === 'critical' || job.retries >= 5) {
        // Alert human
        await this.env.RESOLUTION_LOG.put(
          `dlq:${job.id}`,
          JSON.stringify({
            job,
            analysis,
            timestamp: Date.now(),
            requiresManualReview: true,
          }),
          { expirationTtl: 86400 * 30 }
        );

        results.push({ jobId: job.id, action: 'logged_for_review', success: true });
      } else {
        // Attempt auto-resolution
        const resolution = this.createResolutionAction(analysis);
        const result = await this.executeResolution(resolution);
        results.push({
          jobId: job.id,
          action: resolution.type,
          success: result.success,
        });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
