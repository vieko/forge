# Forge

Minimal AI task orchestrator built on Anthropic's Agent SDK.

## Overview

Forge coordinates planner, worker, and reviewer agents to accomplish complex tasks. The Agent SDK handles orchestration while subagents use Claude Code's native task system.

```
~300 lines total

User Prompt
    ↓
Agent SDK query()
    ↓
┌─────────────────────────────────────┐
│  Subagents (via Task tool)          │
│  ┌─────────┐ ┌────────┐ ┌────────┐  │
│  │ Planner │→│ Worker │→│Reviewer│  │
│  └─────────┘ └────────┘ └────────┘  │
│       ↓          ↓          ↓       │
│  TaskCreate  Edit/Write  TaskCreate │
│  TaskUpdate  TaskUpdate  (fixes)    │
└─────────────────────────────────────┘
```

## Installation

```bash
git clone https://github.com/vieko/forge.git
cd forge
bun install
bun run build
```

## Usage

```bash
# Run a task
forge run "implement feature X"

# With spec file
forge run --spec .bonfire/specs/feature.md "implement this"

# Target different directory
forge run -C ~/other-repo "add tests"

# Resume interrupted session
forge run --resume <session-id>

# Plan only (no implementation)
forge run --plan-only "design API for Y"

# Verbose output
forge run -v "debug issue"
```

## Agent Roles

| Agent | Purpose | Tools |
|-------|---------|-------|
| **Planner** | Decomposes work into tasks | Read, Grep, Glob, TaskCreate, TaskUpdate, TaskList |
| **Worker** | Implements individual tasks | Read, Write, Edit, Bash, Grep, Glob, TaskGet, TaskUpdate, TaskList |
| **Reviewer** | Reviews completed work | Read, Grep, Glob, Bash, TaskCreate, TaskUpdate, TaskList, TaskGet |

## Configuration

Set your API credentials:

```bash
# Option 1: Direct API key
export ANTHROPIC_API_KEY=sk-ant-...

# Option 2: Vercel AI Gateway
export VERCEL_AI_GATEWAY_URL=https://...
export VERCEL_AI_GATEWAY_KEY=vck_...
```

## Development

```bash
# Run in dev mode
bun run src/index.ts run "test task"

# Type check
bun run typecheck

# Build
bun run build
```

## Dependencies

- `@anthropic-ai/claude-agent-sdk` - Agent orchestration
- `commander` - CLI framework
- `zod` - Runtime validation

## License

MIT
