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

# Run all specs in a directory (parallel by default, dep-graph aware)
forge run --spec-dir ./specs/ "implement these"

# Smart dispatch: auto-detects spec dir or file from positional arg
forge gtmeng-572                                # Detects spec dir, runs parallel
forge auth.md                                   # Detects spec file, runs it

# Run specs sequentially (opt out of auto-parallel)
forge run --spec-dir ./specs/ --sequential "implement these"

# Custom concurrency
forge run --spec-dir ./specs/ --concurrency 5 "implement these"

# Run first spec sequentially, then parallelize the rest
forge run --spec-dir ./specs/ --sequential-first 1 "implement these"

# Rerun only failed specs from the latest batch
forge run --rerun-failed -C ~/target-repo "fix failures"

# Run only pending specs from the manifest
forge run --pending "implement pending specs"

# Force re-run of already passed specs
forge run --spec-dir ./specs/ --force "re-verify all"

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

# Run in isolated git worktree
forge run --spec-dir ./specs/ --branch feat "implement"

# Auto-split tmux pane with live logs
forge run --watch "implement feature X"

# Quick alias (no 'run' needed)
forge "simple task"

# Define specs from a description
forge define "build auth system"                # Generate specs in specs/
forge define "add rate limiting" -o specs/api/  # Custom output dir
forge define "refactor database" -C ~/project   # Different repo

# Audit codebase against specs
forge audit specs/                              # Audit all specs in directory
forge audit specs/auth.md                       # Audit a single spec file
forge audit auth.md                             # Shorthand (resolves via manifest)
forge audit specs/ -C ~/target-repo             # Audit a different repo
forge audit specs/ -o ./remediation/            # Custom output directory
forge audit specs/ "focus on auth module"       # With additional context
forge audit specs/ --watch                      # Auto-split tmux pane with live logs
forge audit specs/ --fix                        # Audit-fix loop (audit → fix → re-audit)
forge audit specs/ --fix --fix-rounds 5         # Custom max rounds (default: 3)

# View run results
forge status                    # Latest run
forge status --all              # All runs
forge status -n 5               # Last 5 runs
forge status -C ~/other-repo    # Different repo

# Aggregate run statistics
forge stats                     # Dashboard: total runs, cost, success rate
forge stats --by-spec           # Per-spec breakdown
forge stats --by-model          # Per-model breakdown
forge stats --since 2026-03-01  # Filter by date
forge stats -C ~/other-repo    # Different repo

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
forge specs --unresolve game.md # Reset a spec back to pending
forge specs --check             # Auto-resolve already-implemented pending specs
forge specs --reconcile         # Backfill manifest from .forge/results/ history
forge specs --prune             # Remove orphaned entries from manifest
forge specs --summary           # Directory-level roll-up (compact view)
forge specs -C ~/other-repo     # Different working directory

# Generate test protocol (proof) from implemented specs
forge proof specs/feature.md                    # Single spec proof
forge proof specs/                              # All specs in directory
forge proof specs/a.md specs/b.md specs/c.md    # Multiple specific specs
forge proof specs/ -o ./custom-proofs/          # Custom manifest output directory
forge proof specs/ -C ~/other-repo              # Different repo

# Execute proof test protocols and create PR
forge verify .forge/proofs/                     # Verify all proofs
forge verify .forge/proofs/ --dry-run           # Preview what would be verified
forge verify .forge/proofs/ -C ~/other-repo     # Different repo
forge verify .forge/proofs/ -m opus             # Use opus model

# Review recent git changes
forge review                    # Review main...HEAD
forge review HEAD~5...HEAD      # Specific range
forge review -C ~/other-repo    # Different repo

# Pipeline orchestrator (chains define -> run -> audit -> proof -> verify)
forge pipeline "build auth system"                  # Full pipeline
forge pipeline --from run --spec-dir specs/ "go"    # Start at run stage with existing specs
forge pipeline --gate-all confirm "careful build"   # Pause at every gate for approval
forge pipeline --resume <pipeline-id>               # Resume paused/failed pipeline
forge pipeline status                               # Show current pipeline state
forge pipeline status <pipeline-id>                 # Show specific pipeline

# Interactive TUI
forge tui                       # Session browser + spec lifecycle + pipeline control
forge tui -C ~/other-repo       # TUI for different repo

# Watch live session logs
forge watch                     # Watch latest session (auto-follows batch)
forge watch <session-id>        # Watch specific session
forge watch -C ~/other-repo     # Different repo
```

## Architecture

```
~12750 lines (source) + ~6165 lines (tests)

User Prompt
    ↓
Outcome-focused prompt construction
    ↓
Agent SDK query()  ──────────────────────┐
    ↓                                    │ parallel mode:
Agent works autonomously                 │ worker pool with
    ↓                                    │ auto-tuned concurrency,
System-level verification                │ ASCII spinner display,
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
├── index.ts       # CLI entry + arg parsing + validators + nested session guard
├── abort.ts       # Global AbortController for graceful Ctrl-C shutdown
├── display.ts     # ANSI constants, banner, spinners, printRunSummary, formatElapsed
├── utils.ts       # ForgeError, execAsync, config, resolveSession, isTransientError, sleep, saveResult
├── verify.ts      # detectVerification, runVerification, monorepo detection + scoping
├── core.ts        # QueryConfig, QueryResult, runQuery (SDK wrapper with hooks/streaming)
├── run.ts         # runSingleSpec, BatchResult, countToolCalls
├── specs.ts       # Spec manifest (lifecycle, reconcile, prune, addSpecs, resolveSpecs, assessSpecComplexity, showSpecs)
├── deps.ts        # Dependency parsing, topological sort, cycle detection, parseSource
├── parallel.ts    # workerPool, autoDetectConcurrency, dep-aware execution, runForge, smartDispatch, progressTracker
├── watch.ts       # WatchOptions, colorWatchLine, runWatch
├── audit.ts       # runAudit, runAuditRound, runAuditFixLoop + manifest integration
├── define.ts      # runDefine (spec generation from descriptions)
├── proof.ts       # runProof (test protocol generation from specs)
├── review.ts      # runReview
├── status.ts        # showStatus
├── stats.ts         # showStats (aggregate run statistics)
├── proof-runner.ts   # forge verify (proof parser, check runner, PR creation)
├── pipeline.ts      # Pipeline orchestrator (stage loop, gate polling, single-writer model)
├── pipeline-state.ts # FileSystemStateProvider (CRUD for pipeline.json, file locking)
├── pipeline-types.ts # Pipeline, Stage, Gate, PipelineEvent types, provider interfaces
├── pipeline-status.ts # CLI display for pipeline status
├── mcp.ts           # MCP server (8 tools, stdio transport, async task spawn)
├── tui.tsx          # OpenTUI React TUI (sessions, specs, pipeline tabs)
├── types.ts         # TypeScript types (ForgeResult, SpecManifest, SpecEntry, SpecRun, DefineOptions, MonorepoContext)
├── query.test.ts    # Tests for core utilities
├── deps.test.ts     # Tests for dependency + parseSource
├── specs.test.ts    # Tests for manifest CRUD, locking, integration lifecycle
├── verify.test.ts   # Tests for monorepo detection, scoping, rewriting
├── worktree.test.ts # Tests for worktree create, commit, cleanup
├── define.test.ts   # Tests for spec complexity assessment
├── parallel.test.ts # Tests for smartDispatch, runSpecBatch, filterPassedSpecs
├── stats.test.ts    # Tests for stats aggregation
├── pipeline.test.ts # Tests for pipeline orchestrator (state, gates, resume, artifacts)
├── mcp.test.ts      # Tests for MCP server (protocol-level via stdio client)
└── types.test.ts    # Type validation tests

.forge/
├── .gitignore    # Auto-created: tracks specs.json + pipeline.json
├── specs.json    # Spec lifecycle manifest (committed to git)
├── pipeline.json # Active pipeline state (committed to git)
├── pipelines/    # Historical pipeline states (gitignored)
├── audit.jsonl   # Tool call audit log (gitignored)
├── latest-session.json  # Session persistence for resume (gitignored)
├── sessions/     # Structured event logs per session (gitignored)
├── proofs/       # Generated test protocols (gitignored, pipeline-scoped: proofs/{pipeline-id}/)
└── results/      # Run results (gitignored)
    └── <timestamp>/
        ├── summary.json  # Structured metadata (includes runId)
        └── result.md     # Full result text
```

## How It Works

1. **Prompt construction** — wraps user prompt in outcome-focused template with acceptance criteria
2. **Agent execution** — single SDK `query()` call; agent decides its own approach (direct coding, task breakdown, etc.)
3. **Auto-parallel** — multi-spec runs are parallel by default with dep-graph-aware level ordering; `--sequential` opts out
4. **Smart dispatch** — positional arg that resolves to a spec dir/file auto-dispatches as specs with "implement" prompt
5. **Spec preflight** — single specs assessed for complexity; warns if over thresholds (>8 criteria, >500 words, >6 sections)
6. **Sequential progress** — progress tracker shows checkpoint between each spec (`+` pass, `x` fail, `>` running, `-` pending); deduplicates with batch summary
7. **Sequential-first** — optionally run foundation specs sequentially before parallelizing the rest
8. **Verification** — auto-detects project type, runs build/test commands, feeds errors back for up to 3 fix attempts
9. **Result persistence** — saves structured metadata (with runId for batch grouping) and full result text to `.forge/results/`
10. **Cost tracking** — per-spec and total cost shown in batch summary, with next-step hint (audit on all-pass, rerun-failed on failures)
11. **Rerun failed** — `--rerun-failed` finds failed specs from latest batch and reruns them
12. **Run pending** — `--pending` runs only pending/stuck specs from the manifest
13. **Status** — `forge status` shows results from recent runs grouped by batch
14. **Retry on transient errors** — auto-retries rate limits, network errors, and 500 server errors (3 attempts, exponential backoff)
15. **Audit** — `forge audit` reviews the codebase against specs via a single read-heavy `query()` call and produces new spec files for any remaining work; output feeds directly into `forge run --spec-dir`
16. **Audit fix loop** — `forge audit --fix` runs a convergence cycle: audit → run remediation → re-audit, up to 3 rounds (configurable). Flat `remediation/` directory with round-prefixed specs (`r1-`, `r2-`). Remediation files are preserved for audit trail. Clean-pass hints point to `forge proof`
17. **Spec lifecycle** — `.forge/specs.json` manifest tracks every spec from registration through execution; `forge specs` shows status, run history, cost, and detects orphaned/untracked specs. `--summary` shows directory-level roll-up for large manifests
18. **Resolve specs** — `forge specs --resolve` marks specs as passed without running (for manually completed work)
19. **Check specs** — `forge specs --check` uses a Sonnet agent to triage pending specs against the codebase and auto-resolve implemented ones
20. **Watch auto-follow** — `forge watch` auto-follows to next session during sequential batch runs; renders spec divider headers (`Spec 1/3: name.md`) between sessions
21. **Structured run logs** — `ForgeResult` includes `numTurns`, `toolCalls`, `toolBreakdown`, `verifyAttempts`, `retryAttempts`, `logPath` for post-run analysis
22. **Stats** — `forge stats` aggregates across all runs: total cost, success rate, avg duration. `--by-spec` and `--by-model` breakdowns, `--since` date filter
23. **Graceful Ctrl-C** — two-phase shutdown: first Ctrl-C aborts running SDK queries via `AbortController` and skips pending specs; second Ctrl-C force-exits. Batch summary shows cancelled specs with `--pending` hint
25. **Proof** — `forge proof` reads specs and the codebase, then generates real `.test.ts` files colocated with source (or in the project's test directory), a `manual.md` human checklist, and a `manifest.json` mapping specs to tests. Auto-detects test convention (colocated vs separate) and test framework (bun/vitest/jest). Supports multiple spec paths: `forge proof a.md b.md c.md`. `forge prove` is a backward-compatible alias.
26. **Verify** — `forge verify` reads proofs, runs all automated checks via single agent query per proof, collects human-only steps, and creates a single GitHub PR with a results summary table and human verification task list. Completes the pipeline: define -> run -> audit -> proof -> verify
27. **Nested session guard** — SDK-invoking commands (`run`, `audit`, `define`, `review`, `proof`, `verify`, `specs --check`, `pipeline`) are blocked when running inside Claude Code (`CLAUDECODE=1`). Prints the command to copy. Bypass with `FORGE_ALLOW_NESTED=1` (for debugging only — the nested SDK limitation is real)
28. **Pipeline orchestrator** — `forge pipeline` chains define → run → audit → proof → verify into a single automated flow. Gates between stages control advancement: `auto` (proceed immediately), `confirm` (pause for approval), `review` (pause and show artifacts). Default gates: auto through audit, confirm before proof and verify
29. **Single-writer pipeline** — The pipeline process owns execution and polls for gate changes. TUI and MCP only mutate state (approve/skip gates) — they never spawn child processes. This prevents orphaned processes and race conditions. Pipeline stays alive through gates, polling every 2s for resolution
30. **Pipeline TUI** — Third tab in `forge tui` shows pipeline stages, gates, costs, durations. Interactive controls: `a` advance gate, `s` skip gate, `p` pause, `c` cancel, `r` retry. All actions write state only — the running pipeline process picks up changes
31. **Pipeline MCP** — `forge_pipeline` reads current state, `forge_pipeline_start` spawns a new pipeline process (PID liveness check prevents stale tasks from blocking new spawns)
32. **TUI spec run** — Press `r` on a pending/failed spec in the Specs tab to spawn a detached `forge run --spec <path>`. Guards on status, strips Claude env vars, toast feedback
33. **TUI pipeline start** — Press `n` in the Pipeline tab to start a new pipeline. Guards against active pipeline (running/paused_at_gate), spawns detached process, toast feedback
34. **Scoped pipeline proofs** — Pipeline proof writes to `.forge/proofs/{pipeline-id}/` so verify only processes proofs from the current pipeline, not stale proofs from previous runs

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

**Skill symlink**: The global skill at `~/.agents/skills/forge` must be a symlink to `skills/forge/` in this repo. Never copy — symlink keeps it in sync automatically.

## Configuration

The SDK reads settings from:
- `CLAUDE.md` (this file) - project instructions
- `.claude/settings.json` - Claude Code settings
- Environment variables (ANTHROPIC_API_KEY, etc.)

## Dependencies

- `@anthropic-ai/claude-agent-sdk` - Agent SDK
- `commander` - CLI framework
- `zod` - Runtime validation (SDK dependency)
