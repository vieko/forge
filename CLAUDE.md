# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Forge is a production-ready orchestrator for coordinating multiple Claude Code agents. It provides distributed AI task execution with fault tolerance, monitoring, and multi-runtime support.

**Key Architecture**: Hybrid bridge pattern where BullMQ/Redis is the source of truth, with tasks synced to Claude Code's native task system at `~/.claude/tasks/forge/` for agent transparency.

## Build & Development Commands

```bash
# Build
npm run build              # Compile TypeScript to dist/

# Development
npm run dev                # Run with tsx (no compilation)
npm run typecheck          # Type check without building
npm run cli                # Run CLI directly with tsx

# Testing
npm test                   # Run tests with Vitest
npm run test:coverage      # With coverage report

# Linting & Formatting
npm run lint               # ESLint check
npm run lint:fix           # Auto-fix issues
npm run format             # Prettier format

# CLI Usage (after build)
forge daemon start         # Start orchestrator daemon
forge agent start          # Spawn agent
forge task submit          # Submit task
forge status               # Quick status
```

## Critical TypeScript Patterns

### Import Extensions
**ALWAYS use `.js` extensions in imports, even for TypeScript files**. The compiler doesn't rewrite import paths:

```typescript
// ✅ Correct
import { Orchestrator } from './core/orchestrator.js';
import type { Task } from './types/index.js';

// ❌ Wrong - will fail at runtime
import { Orchestrator } from './core/orchestrator';
```

### Module System
- **Type**: ESM (`"type": "module"` in package.json)
- **Module resolution**: NodeNext (`moduleResolution: "NodeNext"`)
- **Target**: ES2022
- **Strict mode**: Enabled

### Path Aliases
Configure in `tsconfig.json`, but prefer relative imports for reliability:

```typescript
// Available aliases (use sparingly)
@/core/*      → ./src/core/*
@/runtime/*   → ./src/runtime/*
@/types/*     → ./src/types/*
@/utils/*     → ./src/utils/*
```

## Architecture Deep Dive

### Core Event Flow

```
User → CLI → Orchestrator → AgentManager → RuntimeAdapter → Claude Agent
                ↓              ↓               ↓
              Queue   ←   TaskBridge   →  ~/.claude/tasks/forge/
                ↓
              BullMQ → Redis
```

### Component Responsibilities

**Orchestrator** (`src/core/orchestrator.ts`):
- Central coordinator for the entire system
- Polls queue every 1s for pending tasks
- Manages task-to-agent assignment
- Handles MessageHandler for agent communication
- Coordinates graceful shutdown

**AgentManager** (`src/core/agent-manager.ts`):
- Agent lifecycle (spawn/terminate)
- Enforces concurrent limit (default: 5)
- Health checks every 30s
- Role-based filtering (planner/worker/reviewer)
- Exposes `adapters` Map publicly for runtime access

**TaskQueue** (`src/core/queue.ts`):
- BullMQ wrapper for Redis-backed queue
- Priority ordering (1-5, 1 = highest)
- Methods: `submitTask()`, `completeTask()`, `failTask()`
- Automatic retry via BullMQ
- Event emission: `task:created`, `task:completed`, `task:failed`

**TaskBridge** (`src/core/task-bridge.ts`):
- **Hybrid bridge**: BullMQ remains source of truth
- Syncs tasks to `~/.claude/tasks/forge/` as JSON files
- Polls every 2s (configurable via `TASK_SYNC_INTERVAL`)
- Maps Forge statuses → Claude statuses:
  - `queued`/`pending` → `pending`
  - `assigned`/`running` → `in_progress`
  - `completed` → `completed`
  - `failed`/`cancelled` → `deleted`
- Detects agent updates via file polling, emits events

**MessageHandler** (`src/core/message-handler.ts`):
- Routes JSON messages from agent stdout
- Request types: `query-agents`, `query-tasks`, `submit-task`, `get-task`, `ask-user`
- Event types: `progress`, `log`, `error`, `question`
- Correlation IDs for request/response matching
- Rate limiting: 100 msg/sec per agent
- **Backward compatible**: Non-JSON output treated as logs

**WorkspaceManager** (`src/core/workspace-manager.ts`):
- Isolated workspaces per agent at `/tmp/forge-workspaces/agent-{id}/`
- Uses rsync to copy project files
- Shared `.git` via symlink for all agents
- Cleanup on agent termination

**LocalProcessAdapter** (`src/runtime/local.ts`):
- Spawns Claude Code as child processes
- Parses stdout for JSON messages → MessageHandler
- Sends responses/notifications via stdin as JSON
- Monitors process health and memory
- Task execution sends `task_notification` via stdin

### Agent Roles System

Three roles with distinct responsibilities:

1. **Planner** (`role=planner`):
   - Reads `.bonfire/specs/*.md` files
   - Decomposes into task graphs
   - Uses message protocol to submit tasks
   - Creates dependencies for execution order

2. **Worker** (`role=worker`):
   - Executes implementation tasks
   - Can specify capabilities: `["typescript", "testing", "react"]`
   - Isolated workspace per worker

3. **Reviewer** (`role=reviewer`):
   - Code review and quality checks
   - Runs after worker tasks complete
   - Verifies tests, linting, documentation

### Task Lifecycle Detail

1. **Submit** → `forge task submit` → BullMQ queue (status: `queued`)
2. **Assign** → Orchestrator finds idle agent → calls `AgentManager.assignTask()`
3. **Bridge** → `TaskBridge.createClaudeTask()` writes JSON to `~/.claude/tasks/forge/`
4. **Notify** → `LocalProcessAdapter.executeTask()` sends JSON to agent stdin
5. **Execute** → Agent uses `TaskList`, `TaskGet`, `TaskUpdate` (Claude native tools)
6. **Sync** → TaskBridge polls (2s), detects status change → emits event
7. **Complete** → Orchestrator calls `TaskQueue.completeTask()` → agent marked idle

### Status Mapping (Critical)

**BullMQ Job State → Forge Task Status:**
- `waiting`, `delayed` → `queued`
- `active` → `running`
- `completed` → `completed`
- `failed` → `failed`

Remember: BullMQ uses different states than our Task type. Handle edge cases like `delayed` and `retrying`.

## Configuration System

**Environment Variables** (`.env`):
```bash
# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_KEY_PREFIX=forge:

# Claude API (choose one)
ANTHROPIC_API_KEY=sk-ant-xxx
VERCEL_AI_GATEWAY_URL=https://ai-gateway.vercel.sh

# Orchestrator
MAX_CONCURRENT_AGENTS=5
TASK_TIMEOUT=300000
HEALTH_CHECK_INTERVAL=30000
DEFAULT_RUNTIME=local

# Task Integration
ENABLE_NATIVE_TASKS=true      # Default: true
TASK_SYNC_INTERVAL=2000       # Default: 2000ms

# Monitoring
MONITORING_ENABLED=true
LOG_LEVEL=info
```

**Settings File** (`.claude/settings.local.json`):
```json
{
  "env": {
    "CLAUDE_CODE_TASK_LIST_ID": "forge"
  }
}
```

All agents spawned in this directory inherit the shared task list ID.

## Common Patterns

### Event Emission
Use EventEmitter3 for type-safe events. Emit after state changes complete:

```typescript
// ✅ Correct
await updateState();
this.emit('state:changed', newState);

// For fire-and-forget async handlers
this.on('event', (data) => {
  void this.handleAsync(data); // or .catch(err => logger.error(err))
});
```

### File Operations
Always use `promises as fs` from `fs` module:

```typescript
import { promises as fs } from 'fs';

await fs.mkdir(dir, { recursive: true });
await fs.readFile(path, 'utf-8');
```

Handle ENOENT gracefully in health checks and cleanup.

### Logging
Use pino with child loggers for context:

```typescript
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ component: 'task-bridge', taskId });
logger.info({ status }, 'Task status changed');
logger.error({ error }, 'Failed to sync task');
```

### Configuration Validation
Zod schemas with defaults:

```typescript
const configSchema = z.object({
  enableNativeTasks: z.boolean().default(true),
  taskSyncInterval: z.number().min(1000).default(2000),
});

export const config = configSchema.parse(envVars);
```

## Message Protocol (Agent Communication)

Agents communicate with orchestrator via JSON over stdin/stdout:

**Agent Request Example:**
```json
{
  "type": "request:query-tasks",
  "id": "req-uuid",
  "timestamp": "2026-02-04T10:30:00Z",
  "payload": { "status": "queued" }
}
```

**Orchestrator Response:**
```json
{
  "type": "response:success",
  "id": "res-uuid",
  "correlationId": "req-uuid",
  "timestamp": "2026-02-04T10:30:00.123Z",
  "payload": { "tasks": [...] }
}
```

See `docs/MESSAGE_PROTOCOL.md` for full specification.

## Testing Strategy

**Integration Tests** (in `examples/`):
- `test-task-integration.ts` - TaskBridge functionality
- `test-role-system.ts` - Agent roles and workspaces
- `test-agent-communication.ts` - Message protocol
- `test-planner-workflow.ts` - Planning task flow
- `full-integration-test.ts` - End-to-end

Run with: `tsx examples/test-*.ts`

**Unit Tests**: Vitest in `tests/` (currently stub)

## Troubleshooting

### "Cannot find module" errors
- Check import has `.js` extension
- Verify file exists at correct path
- Run `npm run build` to regenerate dist/

### Tasks not syncing
- Check `~/.claude/tasks/forge/` directory exists
- Verify `ENABLE_NATIVE_TASKS=true` in `.env`
- Check daemon logs: `forge daemon logs | grep task-bridge`
- Verify `TASK_SYNC_INTERVAL` is reasonable (1000-5000ms)

### Agent not receiving tasks
- Check `.claude/settings.local.json` has `CLAUDE_CODE_TASK_LIST_ID=forge`
- Verify task notification sent: `forge daemon logs | grep task_notification`
- Check agent workspace has correct settings file

### Redis connection errors
- Verify Redis running: `redis-cli ping`
- Check `REDIS_HOST` and `REDIS_PORT` in `.env`
- For production, use managed Redis (ElastiCache, Upstash)

## Key Files Reference

**Core Engine:**
- `src/core/orchestrator.ts` - Main coordinator (482 lines)
- `src/core/agent-manager.ts` - Agent lifecycle (380 lines)
- `src/core/queue.ts` - BullMQ wrapper (295 lines)
- `src/core/task-bridge.ts` - Claude task sync (350 lines)
- `src/core/message-handler.ts` - Agent messages (243 lines)
- `src/core/workspace-manager.ts` - Workspace isolation (157 lines)

**Runtime:**
- `src/runtime/adapter.ts` - Runtime interface
- `src/runtime/local.ts` - Local process adapter

**Types:**
- `src/types/index.ts` - All TypeScript types (AgentRole, TaskStatus, messages)

**CLI:**
- `src/cli/index.ts` - CLI entry point
- `src/cli/commands/task.ts` - Includes `forge task plan` command
- `src/cli/commands/agent.ts` - Includes `--role` flag

**Documentation:**
- `docs/ARCHITECTURE.md` - System design
- `docs/MESSAGE_PROTOCOL.md` - Agent communication protocol
- `docs/TASK_INTEGRATION.md` - TaskBridge details
- `docs/PLANNER_AGENT.md` - Planner agent guide (427 lines)

**Specs:**
- `.bonfire/specs/autonomous-orchestration.md` - Implementation spec (1810 lines)

## Development Notes

- Total codebase: ~7,300 lines TypeScript
- 100% strict mode, full type safety
- Node.js 18+ required
- Redis required (local or remote)
- Claude Code CLI optional for agent execution

## Production Checklist

- [ ] Use managed Redis (AWS ElastiCache, Redis Cloud, Upstash)
- [ ] Run daemon as systemd service
- [ ] Set `LOG_LEVEL=info` or `warn`
- [ ] Configure resource limits (ulimit, cgroups)
- [ ] Set up Redis backups
- [ ] Monitor with Prometheus + Grafana (future)
- [ ] Use environment-specific configs
- [ ] Enable TLS for Redis connections
