# CLAUDE.md

## Project Overview

Crucible is an outcome-driven development tool built on Anthropic's Agent SDK. Define the outcome, the agent builds and verifies.

**Key Architecture**: Single Agent SDK `query()` call with outcome-based prompts. No procedural agent pipeline — the agent decides its own approach. System-level verification catches errors and loops back for fixes.

## Commands

```bash
# Run a task
crucible run "implement feature X"

# With spec file
crucible run --spec .bonfire/specs/feature.md "implement this"

# Run all specs in a directory sequentially
crucible run --spec-dir ./specs/ "implement these"

# Run specs in parallel (concurrency: auto-detected)
crucible run --spec-dir ./specs/ --parallel "implement these"

# Run specs in parallel with custom concurrency
crucible run --spec-dir ./specs/ -P --concurrency 5 "implement these"

# Run first spec sequentially, then parallelize the rest
crucible run --spec-dir ./specs/ -P --sequential-first 1 "implement these"

# Rerun only failed specs from the latest batch
crucible run --rerun-failed -P -C ~/target-repo "fix failures"

# Configurable max turns (default: 100)
crucible run --max-turns 150 "large task"

# Plan only (no implementation)
crucible run --plan-only "design API for Y"

# Dry run (preview tasks + cost estimate)
crucible run --dry-run "implement feature X"

# Verbose output (full details)
crucible run -v "debug issue Z"

# Quiet mode (for CI, minimal output)
crucible run -q "implement feature X"

# Target a different repo
crucible run -C ~/other-repo "task"

# Resume a previous session
crucible run --resume <session-id> "continue"

# Fork from a previous session (new session, same history)
crucible run --fork <session-id> "try different approach"

# Quick alias (no 'run' needed)
crucible "simple task"

# View run results
crucible status                    # Latest run
crucible status --all              # All runs
crucible status -n 5               # Last 5 runs
crucible status -C ~/other-repo    # Different repo
```

## Architecture

```
~1050 lines total

User Prompt
    ↓
Outcome-focused prompt construction
    ↓
Agent SDK query()  ──────────────────────┐
    ↓                                    │ parallel mode:
Agent works autonomously                 │ worker pool with
    ↓                                    │ auto-tuned concurrency,
System-level verification                │ braille spinner display,
    ├── Auto-detect project (Node/Cargo/Go)  live tool activity
    ├── Run: tsc --noEmit, npm run build, npm test
    ├── Pass → save results
    └── Fail → feed errors back to agent (up to 3 attempts)
    ↓
.crucible/results/<timestamp>/
```

## File Structure

```
src/
├── index.ts    # CLI entry + arg parsing (~110 lines)
├── query.ts    # SDK wrapper, verification, streaming, parallel, status (~1000 lines)
└── types.ts    # TypeScript types (~65 lines)

.crucible/
├── audit.jsonl   # Tool call audit log (with spec filename)
├── latest-session.json  # Session persistence for resume
└── results/      # Run results (auto-created, gitignored)
    └── <timestamp>/
        ├── summary.json  # Structured metadata (includes runId)
        └── result.md     # Full result text
```

## How It Works

1. **Prompt construction** — wraps user prompt in outcome-focused template with acceptance criteria
2. **Agent execution** — single SDK `query()` call; agent decides its own approach (direct coding, task breakdown, etc.)
3. **Parallel execution** — worker pool runs specs concurrently with auto-tuned concurrency (freeMem/2GB, capped at CPUs), braille spinner showing per-spec status and live tool activity
4. **Sequential-first** — optionally run foundation specs sequentially before parallelizing the rest
5. **Verification** — auto-detects project type, runs build/test commands, feeds errors back for up to 3 fix attempts
6. **Result persistence** — saves structured metadata (with runId for batch grouping) and full result text to `.crucible/results/`
7. **Cost tracking** — per-spec and total cost shown in batch summary
8. **Rerun failed** — `--rerun-failed` finds failed specs from latest batch and reruns them
9. **Status** — `crucible status` shows results from recent runs grouped by batch
10. **Retry on transient errors** — auto-retries rate limits and network errors (3 attempts, exponential backoff)

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
