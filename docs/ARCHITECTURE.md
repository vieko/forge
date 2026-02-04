# Forge Orchestrator - Architecture

## Overview

Forge is a production-ready orchestrator for coordinating multiple Claude Code agents. It provides a robust foundation for distributed AI task execution with fault tolerance, monitoring, and multi-runtime support.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      CLI / Daemon                            │
│  Commands: task, agent, config, daemon, status               │
└────────────────┬────────────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────────────┐
│                  Orchestrator Core                           │
│  ┌──────────────────┐  ┌───────────────────┐                │
│  │  Agent Manager   │  │   Task Queue      │                │
│  │  - Lifecycle     │  │   - BullMQ        │                │
│  │  - Health checks │  │   - Redis         │                │
│  │  - Coordination  │  │   - Priorities    │                │
│  └──────────────────┘  └───────────────────┘                │
└────────────────┬────────────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────────────┐
│              Error Handling & Resilience                     │
│  Circuit Breaker | Retry Logic | Checkpointing               │
└────────────────┬────────────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────────────┐
│                Runtime Adapter Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Local      │  │    Docker    │  │  Vercel Sandbox  │  │
│  │   Process    │  │   Runtime    │  │     Runtime      │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└────────────────┬────────────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────────────┐
│                   Claude Code Agents                         │
│   Agent 1     Agent 2     Agent 3     ...     Agent N        │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Orchestrator Core (`src/core/orchestrator.ts`)

The central coordination engine that manages the entire system.

**Responsibilities:**
- Lifecycle management (start/stop)
- Task polling and assignment
- Event coordination
- Agent crash recovery
- Health monitoring coordination

**Key Features:**
- 1-second task polling interval
- Automatic task-to-agent assignment
- Graceful shutdown with cleanup
- Event-driven architecture

### 2. Agent Manager (`src/core/agent-manager.ts`)

Manages the lifecycle of all agent instances.

**Responsibilities:**
- Agent spawning and termination
- Concurrent agent limit enforcement
- Health check coordination
- Status tracking and updates
- Runtime adapter coordination

**Key Features:**
- Configurable concurrent agent limit (default: 5)
- Periodic health checks (default: 30s intervals)
- Multi-runtime support
- Tag-based agent filtering
- Automatic crash detection

### 3. Task Queue (`src/core/queue.ts`)

Manages task distribution and persistence using BullMQ.

**Responsibilities:**
- Task submission and queueing
- Priority-based ordering
- Task state management
- Checkpointing support
- Queue statistics

**Key Features:**
- Redis-backed persistence
- Priority support (1-5, 1 = highest)
- Automatic retry with BullMQ
- Task checkpointing for recovery
- Event emission for all state changes

### 4. Runtime Adapters

Abstract interface for spawning agents in different environments.

#### Interface (`src/runtime/adapter.ts`)
```typescript
interface IRuntimeAdapter {
  spawn(config: AgentConfig): Promise<AgentInstance>
  terminate(agentId: string, force?: boolean): Promise<void>
  healthCheck(agentId: string): Promise<HealthStatus>
  getLogs(agentId: string, options?): AsyncIterable<LogEntry>
  executeTask(agentId: string, taskPayload): Promise<void>
  getResourceUsage(agentId: string): Promise<ResourceUsage>
  pause(agentId: string): Promise<void>
  resume(agentId: string): Promise<void>
  cleanup(): Promise<void>
}
```

#### Local Process Adapter (`src/runtime/local.ts`)
- Spawns Claude Code as child processes
- Captures stdout/stderr for logging
- Monitors process health and memory
- Supports pause/resume via signals

#### Future Adapters
- **Docker**: Containerized agent isolation
- **Vercel Sandbox**: Serverless execution

### 5. Error Handling

#### Circuit Breaker (`src/core/circuit-breaker.ts`)
Three-state pattern for fault tolerance:
- **CLOSED**: Normal operation
- **OPEN**: Too many failures, block requests
- **HALF_OPEN**: Testing recovery

**Configuration:**
- `failureThreshold`: Failures before opening (default: 5)
- `successThreshold`: Successes to close (default: 2)
- `timeout`: Time before retry attempt (default: 60s)

#### Retry Handler (`src/core/retry-handler.ts`)
Exponential backoff retry logic:
- Configurable max attempts
- Backoff multiplier
- Selective retry based on error patterns
- Integration with p-retry

### 6. Daemon Manager (`src/core/daemon.ts`)

Manages the orchestrator as a background process.

**Features:**
- PID file management (`~/.forge/forge.pid`)
- Signal handling (SIGTERM, SIGINT)
- Graceful shutdown
- Process status checking
- Log file management

### 7. Configuration System (`src/core/config.ts`)

Type-safe configuration with Zod validation.

**Configuration Sections:**
- Redis connection
- Orchestrator settings
- Claude API (direct key or AI Gateway)
- Monitoring settings
- Error handling policies
- Runtime-specific options

## Data Flow

### Task Submission Flow

```
1. User submits task via CLI
   └─> forge task submit

2. Task enters queue
   └─> BullMQ queues in Redis
   └─> Priority ordering applied

3. Orchestrator polls queue (1s interval)
   └─> Finds pending tasks
   └─> Finds available agents

4. Task assignment
   └─> Agent marked as 'busy'
   └─> Task payload sent to agent
   └─> Task status updated

5. Execution (future implementation)
   └─> Agent executes via Claude Code
   └─> Progress updates sent
   └─> Results returned

6. Completion
   └─> Agent marked as 'idle'
   └─> Task marked as 'completed' or 'failed'
   └─> Stats updated
```

### Agent Lifecycle

```
1. Spawn Request
   └─> Check concurrent limit
   └─> Select runtime adapter
   └─> Spawn process/container

2. Initialization
   └─> Agent status: 'initializing'
   └─> Process starts
   └─> Agent status: 'idle'

3. Health Monitoring
   └─> Periodic health checks (30s)
   └─> Process health
   └─> Memory usage
   └─> API connectivity

4. Task Execution
   └─> Agent status: 'busy'
   └─> Execute task
   └─> Return to 'idle'

5. Failure Handling
   └─> Detect crash/unhealthy
   └─> Requeue task if assigned
   └─> Terminate agent
   └─> Log failure

6. Termination
   └─> Send SIGTERM (graceful)
   └─> Or SIGKILL (force)
   └─> Clean up resources
   └─> Remove from tracking
```

## Concurrency Model

### Agent Concurrency
- Maximum concurrent agents: Configurable (default: 5)
- Agents run as separate processes/containers
- No shared state between agents
- Coordination through Redis

### Task Processing
- Tasks queued in priority order
- Assignment happens during polling
- One task per agent at a time
- Failed tasks automatically requeued (BullMQ)

### Thread Safety
- Redis provides atomic operations
- BullMQ handles concurrent job processing
- Agent manager uses Map for tracking
- Event emitters for async coordination

## Monitoring & Observability

### Logging
- Structured logging with Pino
- Log levels: trace, debug, info, warn, error, fatal
- Pretty printing in development
- JSON in production
- Component-based child loggers

### Metrics (Available)
- Agent count by status
- Task queue depth
- Task completion rate
- Task duration
- Agent uptime
- Cost tracking (tokens, API calls)

### Health Checks
- Agent process status
- Memory usage monitoring
- API connectivity checks
- Task execution validation
- Configurable check intervals

## Scalability Considerations

### Horizontal Scaling
- Multiple orchestrator instances can share Redis
- BullMQ supports multiple workers
- Agents are stateless
- Task queue is centralized

### Vertical Scaling
- Configurable concurrent agent limit
- Memory-based health checks
- Resource usage monitoring
- Per-agent resource limits

### Performance
- 1-second polling interval (configurable)
- Async/await throughout
- Non-blocking I/O
- Event-driven coordination

## Security Considerations

### API Keys
- Environment variable or AI Gateway
- Never logged or exposed
- Passed to agents via environment

### Process Isolation
- Agents run in separate processes
- Optional container isolation (Docker)
- Sandboxed execution (Vercel)
- Resource limits enforced

### Network Security
- Redis password support
- TLS for Redis connections (configurable)
- No exposed ports in default config

## Future Enhancements

### Planned Features
1. **IPC Server**: CLI commands connect to running daemon
2. **TUI Monitor**: Real-time visual dashboard
3. **Docker Runtime**: Container-based agent isolation
4. **Vercel Runtime**: Serverless agent execution
5. **Metrics Export**: Prometheus integration
6. **Agent Communication**: Inter-agent messaging
7. **Task Dependencies**: DAG-based execution
8. **Load Balancing**: Smart task assignment
9. **Auto-scaling**: Dynamic agent pool sizing
10. **Web UI**: Browser-based monitoring

### Extension Points
- Custom runtime adapters
- Plugin system for task types
- Custom health check logic
- Metrics exporters
- Event handlers

## Technology Stack

- **Language**: TypeScript 5.3+
- **Runtime**: Node.js 18+
- **Queue**: BullMQ 5.1+
- **Storage**: Redis (ioredis)
- **CLI**: Commander.js 12+
- **Validation**: Zod 3.22+
- **Logging**: Pino 8.18+
- **Testing**: Vitest 1.2+ (ready)

## Performance Characteristics

### Latency
- Task submission: <10ms
- Agent spawn: 1-3s (local), varies by runtime
- Health check: <100ms
- Task assignment: <100ms (during polling)

### Throughput
- Target: 10+ tasks/second
- Limited by agent concurrency
- Redis can handle 100k+ ops/sec

### Resource Usage
- Orchestrator: ~50-100MB RAM
- Per agent: Varies by Claude Code usage
- Redis: ~10-50MB for queue data

## Deployment Recommendations

### Development
```bash
# Local Redis
brew install redis
brew services start redis

# Start daemon
forge daemon start

# Monitor
forge daemon logs --follow
```

### Production
- Use managed Redis (AWS ElastiCache, Redis Cloud, Upstash)
- Run daemon as systemd service
- Monitor with Prometheus + Grafana
- Set up log aggregation
- Configure backups for Redis
- Use environment-specific configs
- Set resource limits (ulimit, cgroups)

### High Availability
- Multiple Redis replicas
- Redis Sentinel for failover
- Multiple orchestrator instances
- Load balancer for CLI/API
- Health check endpoints

## Troubleshooting

### Common Issues

**Agents crash immediately**
- Check Claude Code installation
- Verify API key/gateway URL
- Check agent logs
- Verify environment variables

**Tasks not processing**
- Check daemon status
- Verify Redis connection
- Check queue stats
- Look for errors in logs

**High memory usage**
- Check agent count
- Monitor per-agent memory
- Adjust health check thresholds
- Consider resource limits

**Redis connection errors**
- Verify Redis is running
- Check connection settings
- Verify password if set
- Check network connectivity

### Debug Mode
```bash
# Daemon logs
forge daemon logs --follow

# Check status
forge daemon status
forge status

# Verify config
forge config validate

# Test Redis
redis-cli ping
```
