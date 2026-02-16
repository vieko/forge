# CLAUDE.md

## Project Overview

Forge is a verification boundary for autonomous agents, built on Anthropic's Agent SDK. Define outcomes, not procedures.

**Key Architecture**: Single Agent SDK `query()` call with outcome-based prompts. No procedural agent pipeline — the agent decides its own approach. System-level verification catches errors and loops back for fixes.

## Commands

```bash
# Run a task
forge run "implement feature X"

# With spec file
forge run --spec .bonfire/specs/feature.md "implement this"

# Run all specs in a directory sequentially
forge run --spec-dir ./specs/ "implement these"

# Run specs in parallel (concurrency: auto-detected)
forge run --spec-dir ./specs/ --parallel "implement these"

# Run specs in parallel with custom concurrency
forge run --spec-dir ./specs/ -P --concurrency 5 "implement these"

# Run first spec sequentially, then parallelize the rest
forge run --spec-dir ./specs/ -P --sequential-first 1 "implement these"

# Rerun only failed specs from the latest batch
forge run --rerun-failed -P -C ~/target-repo "fix failures"

# Run only pending specs from the manifest
forge run --pending -P "implement pending specs"

# Configurable max turns (default: 250)
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

# Fork from a previous session (new session, same history)
forge run --fork <session-id> "try different approach"

# Quick alias (no 'run' needed)
forge "simple task"

# Define specs from a description
forge define "build auth system"                # Generate specs in specs/
forge define "add rate limiting" -o specs/api/  # Custom output dir
forge define "refactor database" -C ~/project   # Different repo

# Audit codebase against specs
forge audit specs/                              # Audit, output to specs/audit/
forge audit specs/ -C ~/target-repo             # Audit a different repo
forge audit specs/ -o ./remediation/            # Custom output directory
forge audit specs/ "focus on auth module"       # With additional context
forge audit specs/ --watch                      # Auto-split tmux pane with live logs

# View run results
forge status                    # Latest run
forge status --all              # All runs
forge status -n 5               # Last 5 runs
forge status -C ~/other-repo    # Different repo

# Spec lifecycle tracking
forge specs                     # List all tracked specs with status
forge specs --pending           # Show only pending specs
forge specs --failed            # Show only failed specs
forge specs --passed            # Show only passed specs
forge specs --orphaned          # Specs in manifest but file missing
forge specs --untracked         # .md files in spec dirs not in manifest
forge specs --add               # Register all untracked specs
forge specs --add specs/new.md  # Register specific spec by path/glob
forge specs --resolve game.md   # Mark a pending/failed spec as passed
forge specs --check             # Auto-resolve already-implemented pending specs
forge specs --reconcile         # Backfill manifest from .forge/results/ history
forge specs --prune             # Remove orphaned entries from manifest
forge specs -C ~/other-repo     # Different working directory
```

## Architecture

```
~4000 lines (source) + ~1500 lines (tests)

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
.forge/results/<timestamp>/
```

## File Structure

```
src/
├── index.ts       # CLI entry + arg parsing + validators
├── display.ts     # ANSI constants, banner, spinners, printRunSummary, formatElapsed
├── utils.ts       # ForgeError, execAsync, config, resolveSession, isTransientError, sleep, saveResult
├── verify.ts      # detectVerification, runVerification
├── core.ts        # QueryConfig, QueryResult, runQuery (SDK wrapper with hooks/streaming)
├── run.ts         # runSingleSpec, BatchResult
├── specs.ts       # Spec manifest (lifecycle, reconcile, prune, addSpecs, resolveSpecs, showSpecs)
├── deps.ts        # Dependency parsing, topological sort, cycle detection, parseSource
├── parallel.ts    # workerPool, autoDetectConcurrency, dep-aware execution, runForge
├── watch.ts       # WatchOptions, colorWatchLine, runWatch
├── audit.ts       # runAudit + manifest integration
├── define.ts      # runDefine (spec generation from descriptions)
├── review.ts      # runReview
├── status.ts      # showStatus
├── types.ts       # TypeScript types (ForgeResult, SpecManifest, SpecEntry, SpecRun, DefineOptions)
├── query.test.ts  # Tests for core utilities
├── deps.test.ts   # Tests for dependency + parseSource
├── specs.test.ts  # Tests for manifest CRUD, locking, integration lifecycle
└── types.test.ts  # Type validation tests

.forge/
├── specs.json    # Spec lifecycle manifest (tracked specs, run history)
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
6. **Result persistence** — saves structured metadata (with runId for batch grouping) and full result text to `.forge/results/`
7. **Cost tracking** — per-spec and total cost shown in batch summary
8. **Rerun failed** — `--rerun-failed` finds failed specs from latest batch and reruns them
9. **Run pending** — `--pending` runs only pending/stuck specs from the manifest
10. **Status** — `forge status` shows results from recent runs grouped by batch
11. **Retry on transient errors** — auto-retries rate limits and network errors (3 attempts, exponential backoff)
12. **Audit** — `forge audit` reviews the codebase against specs via a single read-heavy `query()` call and produces new spec files for any remaining work; output feeds directly into `forge run --spec-dir`
13. **Spec lifecycle** — `.forge/specs.json` manifest tracks every spec from registration through execution; `forge specs` shows status, run history, cost, and detects orphaned/untracked specs
14. **Resolve specs** — `forge specs --resolve` marks specs as passed without running (for manually completed work)
15. **Check specs** — `forge specs --check` uses a Sonnet agent to triage pending specs against the codebase and auto-resolve implemented ones

## Spec Naming

- Prefer descriptive feature names: `dep-graph.md`, `spec-lifecycle.md`
- Use subdirectories for grouping: `auth/login.md`, `auth/oauth.md`
- Numeric prefixes are optional; use only when execution order matters and `depends:` is not in use
- GitHub issue numbers go in the frontmatter `source:` field, not the filename
- Keep names lowercase, hyphen-separated, `.md` extension

```yaml
---
source: github:vieko/forge#42
depends: [auth-base.md]
---
```

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
