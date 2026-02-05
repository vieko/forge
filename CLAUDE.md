# CLAUDE.md

## Project Overview

Forge is a minimal AI task orchestrator built on Anthropic's Agent SDK. It sends outcome-focused prompts to Claude and verifies the results automatically.

**Key Architecture**: Single Agent SDK `query()` call with outcome-based prompts. No procedural agent pipeline — the agent decides its own approach. System-level verification catches errors and loops back for fixes.

## Commands

```bash
# Run a task
forge run "implement feature X"

# With spec file
forge run --spec .bonfire/specs/feature.md "implement this"

# Run all specs in a directory sequentially
forge run --spec-dir ./specs/ "implement these"

# Configurable max turns (default: 100)
forge run --max-turns 150 "large task"

# Plan only (no implementation)
forge run --plan-only "design API for Y"

# Dry run (preview tasks + cost estimate)
forge run --dry-run "implement feature X"

# Verbose output (full details)
forge run -v "debug issue Z"

# Quiet mode (for CI, minimal output)
forge run -q "implement feature X"

# Target a different repo
forge run -C ~/other-repo "task"

# Resume a previous session
forge run --resume <session-id> "continue"

# Quick alias (no 'run' needed)
forge "simple task"
```

## Architecture

```
~550 lines total

User Prompt
    ↓
Outcome-focused prompt construction
    ↓
Agent SDK query()
    ↓
Agent works autonomously (Read, Write, Edit, Bash, etc.)
    ↓
System-level verification
    ├── Auto-detect project (Node/Cargo/Go)
    ├── Run: tsc --noEmit, npm run build, npm test
    ├── Pass → save results
    └── Fail → feed errors back to agent (up to 3 attempts)
    ↓
.forge/results/<timestamp>/
```

## File Structure

```
src/
├── index.ts    # CLI entry + arg parsing (~70 lines)
├── query.ts    # SDK wrapper, verification loop, progress (~420 lines)
└── types.ts    # TypeScript types (~55 lines)

.forge/
└── results/    # Run results (auto-created, gitignored)
    └── <timestamp>/
        ├── summary.json  # Structured metadata
        └── result.md     # Full result text
```

## How It Works

1. **Prompt construction** — wraps user prompt in outcome-focused template with acceptance criteria
2. **Agent execution** — single SDK `query()` call; agent decides its own approach (direct coding, task breakdown, etc.)
3. **Verification** — auto-detects project type, runs build/test commands, feeds errors back for up to 3 fix attempts
4. **Result persistence** — saves structured metadata and full result text to `.forge/results/`
5. **Retry on transient errors** — auto-retries rate limits and network errors (3 attempts, exponential backoff)

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
