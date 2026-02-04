# Forge - Claude Code Orchestrator

> A production-ready orchestrator for coordinating multiple Claude Code agents with fault tolerance, monitoring, and multi-runtime support.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## Features

- 🎯 **Multi-Agent Coordination** - Distribute tasks across multiple Claude Code agents
- 📊 **Task Queue Management** - Redis-backed persistent task queue with BullMQ
- 🔄 **Error Recovery** - Circuit breaker, automatic retry, and task checkpointing
- 🐳 **Runtime Flexibility** - Support for local processes, Docker, and Vercel Sandboxes
- 📈 **Monitoring** - Health checks, metrics, and structured logging
- 🛠️ **CLI Tool** - Complete command-line interface for management
- 🔧 **Daemon Mode** - Background operation with process management
- 💪 **Production Ready** - Type-safe, tested, and fault-tolerant
- 📋 **Claude Code Task Integration** - Native task list support for agent transparency

## Quick Start

### Prerequisites

- Node.js 18+
- Redis (local or remote)
- Claude Code CLI (optional, for agent execution)

### Installation

```bash
# Clone and install
git clone https://github.com/vieko/forge.git
cd forge
npm install

# Configure environment
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY or VERCEL_AI_GATEWAY_URL

# Build
npm run build

# Start Redis (if needed)
brew services start redis  # macOS
```

### Basic Usage

```bash
# Start the daemon
forge daemon start

# Check status
forge daemon status
forge status

# Spawn an agent
forge agent start

# Submit a task
forge task submit -t "code-review" -n "Review authentication module" -p 1

# Monitor tasks
forge task list
forge task stats

# View logs
forge daemon logs --follow

# Stop daemon
forge daemon stop
```

### Claude Code Task Integration

Forge integrates with Claude Code's native task system. Agents can use built-in tools:
- `TaskList` - View all tasks in the queue
- `TaskGet` - Read task details
- `TaskUpdate` - Report progress and completion

Tasks are automatically synced to `~/.claude/tasks/forge/` for multi-agent coordination.

**Configuration:**
```bash
# Enable native task integration (default: true)
ENABLE_NATIVE_TASKS=true

# Task sync interval in milliseconds (default: 2000)
TASK_SYNC_INTERVAL=2000
```

The task list ID is configured in `.claude/settings.local.json`:
```json
{
  "env": {
    "CLAUDE_CODE_TASK_LIST_ID": "forge"
  }
}
```

Agents spawned in this directory automatically inherit the shared task list.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              CLI / Daemon                            │
│  task | agent | config | daemon | status            │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│           Orchestrator Core                          │
│  ┌────────────────┐  ┌──────────────────┐          │
│  │ Agent Manager  │  │   Task Queue     │          │
│  │ - Lifecycle    │  │   - BullMQ       │          │
│  │ - Health       │  │   - Redis        │          │
│  └────────────────┘  └──────────────────┘          │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│        Error Handling & Resilience                   │
│  Circuit Breaker | Retry Logic | Checkpointing      │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│           Runtime Adapter Layer                      │
│  [Local Process] [Docker] [Vercel Sandbox]          │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│              Claude Code Agents                      │
└─────────────────────────────────────────────────────┘
```

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed architecture documentation.

## CLI Commands

### Daemon Management
```bash
forge daemon start              # Start daemon in background
forge daemon start --foreground # Run in foreground (debug)
forge daemon stop              # Stop daemon gracefully
forge daemon stop --force      # Force stop (SIGKILL)
forge daemon restart           # Restart daemon
forge daemon status            # Check daemon status
forge daemon logs             # View logs
forge daemon logs --follow    # Tail logs
```

### Task Management
```bash
forge task submit -t <type> -n <name> -p <priority>
forge task submit --file task.json
forge task list
forge task list --status running
forge task get <task-id>
forge task cancel <task-id>
forge task stats
```

### Agent Management
```bash
forge agent start
forge agent start --tags "worker,backend"
forge agent stop <agent-id>
forge agent stop <agent-id> --force
forge agent list
forge agent list --status idle
forge agent get <agent-id>
```

### Configuration
```bash
forge config show              # Show current config
forge config validate          # Validate config
forge status                   # Quick status overview
```

## Configuration

### Environment Variables

```bash
# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_KEY_PREFIX=forge:

# Claude API (choose one)
ANTHROPIC_API_KEY=sk-ant-your-key
# OR
VERCEL_AI_GATEWAY_URL=https://ai-gateway.vercel.sh

# Orchestrator
MAX_CONCURRENT_AGENTS=5
TASK_TIMEOUT=300000
HEALTH_CHECK_INTERVAL=30000
DEFAULT_RUNTIME=local

# Monitoring
MONITORING_ENABLED=true
LOG_LEVEL=info
METRICS_PORT=9090

# Error Handling
MAX_RETRIES=3
RETRY_DELAY_MS=1000
CIRCUIT_BREAKER_THRESHOLD=5
```

See [.env.example](.env.example) for complete configuration options.

## Development

```bash
# Development mode
npm run dev

# Build
npm run build

# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format

# Testing
npm test
npm run test:coverage
```

## Project Structure

```
forge/
├── src/
│   ├── core/           # Orchestrator engine
│   │   ├── orchestrator.ts
│   │   ├── agent-manager.ts
│   │   ├── queue.ts
│   │   ├── config.ts
│   │   ├── daemon.ts
│   │   ├── circuit-breaker.ts
│   │   └── retry-handler.ts
│   ├── runtime/        # Runtime adapters
│   │   ├── adapter.ts
│   │   └── local.ts
│   ├── cli/           # CLI commands
│   │   ├── index.ts
│   │   └── commands/
│   ├── types/         # TypeScript types
│   └── utils/         # Utilities
├── tests/            # Test suites
├── examples/         # Example scripts
├── docs/            # Documentation
└── .bonfire/        # Development context
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System design and components
- [API Reference](docs/API.md) - Programmatic API documentation
- [Usage Guide](docs/USAGE.md) - Detailed usage examples

## Examples

### Example Task Definition

```json
{
  "type": "code-review",
  "name": "Review authentication module",
  "description": "Review auth changes for security issues",
  "priority": 1,
  "payload": {
    "files": ["src/auth/**/*.ts"],
    "focusAreas": ["security", "error-handling"]
  },
  "tags": ["security", "urgent"],
  "retryPolicy": {
    "maxAttempts": 3,
    "backoffMs": 1000,
    "backoffMultiplier": 2,
    "maxBackoffMs": 10000
  }
}
```

### Programmatic Usage

```typescript
import { Orchestrator } from '@vieko/forge';

const orchestrator = new Orchestrator();

// Start orchestrator
await orchestrator.start();

// Spawn agents
const agent = await orchestrator.spawnAgent({
  runtime: 'local',
  claudeConfig: {},
  tags: ['worker']
});

// Submit task
const task = await orchestrator.submitTask({
  type: 'code-review',
  name: 'Review PR #123',
  priority: 1,
  payload: { prNumber: 123 }
});

// Monitor
const stats = await orchestrator.getQueueStats();
console.log('Waiting:', stats.waiting);

// Cleanup
await orchestrator.stop();
```

## Monitoring

### Health Checks
- Automatic health checks every 30 seconds (configurable)
- Process status monitoring
- Memory usage tracking
- API connectivity validation

### Metrics
- Agent count by status
- Task queue depth
- Task completion rate
- Cost tracking (tokens, API calls)

### Logging
- Structured JSON logs with Pino
- Component-based child loggers
- Pretty printing in development
- Log levels: trace, debug, info, warn, error, fatal

## Troubleshooting

### Daemon won't start
```bash
# Check if already running
forge daemon status

# Check Redis
redis-cli ping

# Verify config
forge config validate

# Start in foreground to see errors
forge daemon start --foreground
```

### Tasks not processing
```bash
# Check queue stats
forge task stats

# Check agent status
forge agent list

# View daemon logs
forge daemon logs --follow
```

### Agents crashing
```bash
# Check agent logs
forge agent get <agent-id>

# Verify Claude Code installation
which claude
claude --version

# Check environment
forge config show
```

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT © [vieko](https://github.com/vieko)

## Acknowledgments

- Built with [Claude Code](https://claude.ai/code)
- Powered by [BullMQ](https://docs.bullmq.io/)
- CLI with [Commander.js](https://github.com/tj/commander.js)
- Validation with [Zod](https://zod.dev/)
- Logging with [Pino](https://getpino.io/)

## Support

- [Issues](https://github.com/vieko/forge/issues)
- [Discussions](https://github.com/vieko/forge/discussions)
- [Documentation](https://github.com/vieko/forge/tree/main/docs)

