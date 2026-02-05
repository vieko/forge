# CLAUDE.md

## Project Overview

Forge is a minimal AI task orchestrator built on Anthropic's Agent SDK. It coordinates planner, worker, and reviewer agents to accomplish complex tasks using Claude Code's native task system.

**Key Architecture**: Agent SDK handles orchestration; subagents use TaskCreate/TaskUpdate/TaskList natively.

## Commands

```bash
# Run a task
forge run "implement feature X"

# With spec file
forge run --spec .bonfire/specs/feature.md "implement this"

# Plan only (no implementation)
forge run --plan-only "design API for Y"

# Dry run (preview tasks + cost estimate)
forge run --dry-run "implement feature X"

# Verbose output
forge run -v "debug issue Z"

# Quick alias (no 'run' needed)
forge "simple task"
```

## Architecture

```
~300 lines total (down from ~4,600)

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
    ↓
~/.claude/tasks/ (native task system)
```

## File Structure

```
src/
├── index.ts    # CLI entry (~50 lines)
├── agents.ts   # Subagent definitions (~95 lines)
├── query.ts    # SDK wrapper (~140 lines)
└── types.ts    # TypeScript types (~50 lines)

.forge/
└── results/    # Run results (auto-created, gitignored)
    └── <timestamp>/
        ├── summary.json  # Structured metadata
        └── result.md     # Full result text
```

## Agent Roles

### Planner
- Reads specs/prompts and decomposes into tasks
- Uses TaskCreate with clear subjects and descriptions
- Sets task dependencies via TaskUpdate
- Tools: Read, Grep, Glob, TaskCreate, TaskUpdate, TaskList

### Worker
- Implements individual tasks
- Makes minimal, focused code changes
- Updates task status on completion
- Tools: Read, Write, Edit, Bash, Grep, Glob, TaskGet, TaskUpdate, TaskList

### Reviewer
- Reviews completed work for quality/security
- Creates fix tasks if issues found (max 3 per review)
- Approves work via TaskUpdate
- Tools: Read, Grep, Glob, Bash, TaskCreate, TaskUpdate, TaskList, TaskGet

## Development

```bash
# Run in dev mode
bun run src/index.ts run "test task"

# Type check
bun run typecheck

# Build for production
bun run build
```

## Configuration

The SDK reads settings from:
- `CLAUDE.md` (this file) - project instructions
- `.claude/settings.json` - Claude Code settings
- Environment variables (ANTHROPIC_API_KEY, etc.)

## Dependencies

- `@anthropic-ai/claude-agent-sdk` - Agent SDK
- `commander` - CLI framework
- `zod` - Runtime validation (SDK dependency)

## Migration from v1

The previous implementation (~4,600 lines) used:
- Custom message protocol
- File-based task queue
- Manual subprocess spawning
- Custom role system

The new implementation uses:
- Agent SDK's native orchestration
- SDK subagents for role separation
- Native task tools (TaskCreate, etc.)
- ~350 lines total
