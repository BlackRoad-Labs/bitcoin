# ⬛⬜🛣️ BlackRoad Cloudflare Workers Agent System

A comprehensive Cloudflare Workers-based agent system for monitoring, analyzing, and maintaining cohesiveness across BlackRoad repositories.

## Features

- **Repository Scraping**: Automated scraping of GitHub repositories for structure, dependencies, and metadata
- **Cohesiveness Analysis**: Cross-repository analysis to ensure consistency in dependencies, configs, and conventions
- **Auto-Updates**: Automatic detection of repository changes via webhooks and polling
- **Self-Resolution**: Autonomous failure recovery with circuit breakers and intelligent retry strategies
- **Job Queue**: Priority-based job scheduling with Durable Objects
- **Health Monitoring**: Continuous health checks with degradation detection

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers Edge                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   Hono API   │  │  Job Queue   │  │ Cron Triggers│          │
│  │   Handler    │  │   Consumer   │  │   Handler    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                  │                  │
│         └────────────┬────┴──────────────────┘                  │
│                      │                                          │
│  ┌───────────────────▼────────────────────────────────────────┐ │
│  │                  Durable Objects                            │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌────────────┐ ┌────────┐ │ │
│  │  │   Agent     │ │    Job      │ │    Repo    │ │  Self  │ │ │
│  │  │ Coordinator │ │   Queue     │ │  Watcher   │ │ Healer │ │ │
│  │  └─────────────┘ └─────────────┘ └────────────┘ └────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                      │                                          │
│  ┌───────────────────▼────────────────────────────────────────┐ │
│  │                    Storage Layer                            │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌────────────────────────┐ │ │
│  │  │  KV Store   │ │   Queues    │ │    R2 Bucket          │ │ │
│  │  │ (Cache)     │ │ (Jobs/DLQ)  │ │ (Artifacts)           │ │ │
│  │  └─────────────┘ └─────────────┘ └────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Durable Objects

### AgentCoordinator
Central coordination hub for all agent activities:
- Agent registration and heartbeat monitoring
- Job assignment and completion tracking
- System health aggregation

### JobQueue
Priority-based job scheduling:
- FIFO within priority levels (critical > high > normal > low)
- Scheduled job support
- Automatic retry with exponential backoff
- Dead letter queue for failed jobs

### RepoWatcher
Repository monitoring and change detection:
- Polling-based change detection
- GitHub webhook integration
- Self-update checking
- Configurable watch intervals

### SelfHealer
Autonomous failure recovery:
- Failure pattern recognition
- Circuit breaker implementation
- Multiple resolution strategies
- Automatic rollback support

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | API info and available endpoints |
| `/health` | GET | Detailed health status |
| `/status` | GET | Full system status |
| `/scrape/:org/:repo` | POST | Scrape a specific repository |
| `/scrape-all` | POST | Scrape all configured repositories |
| `/repos/:org/:repo` | GET | Get cached repository data |
| `/analyze` | POST | Run cohesiveness analysis |
| `/report` | GET | Get latest cohesiveness report |
| `/webhook` | POST | GitHub webhook handler |
| `/jobs` | GET | Job queue status |
| `/jobs/trigger` | POST | Manually trigger a job |
| `/watch/:org/:repo` | POST | Start watching a repository |
| `/healer` | GET | Self-healer status |

## Job Types

| Type | Description |
|------|-------------|
| `SCRAPE_REPO` | Scrape a single repository |
| `ANALYZE_COHESIVENESS` | Run cross-repo cohesiveness analysis |
| `SYNC_REPOS` | Trigger scrape for all configured repos |
| `HEALTH_CHECK` | Run system health check |
| `UPDATE_CHECK` | Check for system updates |
| `SELF_HEAL` | Execute self-healing resolution |

## Scheduled Tasks (Cron)

| Schedule | Task |
|----------|------|
| Every 15 min | Quick health check |
| Hourly | Full repository scan |
| Daily | Deep cohesiveness analysis + update check |
| Weekly | Comprehensive self-resolution audit |

## Self-Resolution Strategies

The SelfHealer implements multiple resolution strategies:

1. **RETRY_JOB**: Retry with exponential backoff
2. **RESTART_AGENT**: Reinitialize an agent
3. **CLEAR_CACHE**: Invalidate stale cache entries
4. **REFRESH_TOKEN**: Refresh authentication tokens
5. **FALLBACK_SOURCE**: Switch to alternative data source
6. **SCALE_DOWN**: Reduce concurrency under load
7. **AUTO_FIX**: Attempt automatic code fixes
8. **ALERT_HUMAN**: Escalate to manual intervention

## Configuration

### Environment Variables

```toml
[vars]
ENVIRONMENT = "production"
GITHUB_ORG = "BlackRoad-OS"
PRIMARY_REPOS = "blackroad-prism-console,bitcoin"
```

### Secrets

```bash
# Set GitHub token for API access
wrangler secret put GITHUB_TOKEN
```

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Type check
npm run typecheck

# Deploy
npm run deploy
```

## Cohesiveness Metrics

The analyzer evaluates repositories across multiple dimensions:

- **Dependency Alignment**: Version consistency across repos
- **Config Consistency**: Presence of standard config files
- **Naming Conventions**: Directory and file naming patterns
- **Workflow Alignment**: CI/CD pipeline consistency
- **Documentation Coverage**: README, LICENSE, CONTRIBUTING presence
- **Version Sync**: Major version alignment for core tools

## Circuit Breaker States

```
    ┌─────────┐
    │  Closed │ ←─────────────────────┐
    └────┬────┘                       │
         │ (failure threshold)        │ (success in half-open)
         ▼                            │
    ┌─────────┐  (cooldown elapsed)  ┌┴──────────┐
    │  Open   │ ──────────────────→  │ Half-Open │
    └─────────┘                      └───────────┘
```

## License

MIT
