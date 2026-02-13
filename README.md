# Forge

Outcome-driven development with agents. Shaped by prompts, Tempered by fire.

## The Problem

Complex features require multiple steps: reading code, planning tasks, implementing changes, verifying results. Doing this manually with Claude Code means constant back-and-forth.

## The Solution

Define the outcome. The agent builds and verifies. Forge wraps Claude Code in an outcome-focused prompt, runs it, checks the output, and loops back until it passes.

```
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
    └── Fail → feed errors back (up to 3 attempts)
    ↓
.forge/results/<timestamp>/
```

## Real Example

```bash
$ forge run -C ~/dev/arkanoid-game --spec specs/power-ups.md "implement power-ups"

# Result: 8 power-ups implemented, verification passed
# Cost: $6.03 | Time: ~8 min
```

## Installation

```bash
# From npm
npm install -g @vieko/forge

# From source
git clone https://github.com/vieko/forge.git
cd forge
bun install
bun run build
```

## Usage

```bash
# Run a task
forge run "implement feature X"

# Quick alias (no 'run' needed)
forge "simple task"

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

# Target different directory
forge run -C ~/other-repo "add tests"

# Resume interrupted session
forge run --resume <session-id> "continue"

# Fork from a previous session (new session, same history)
forge run --fork <session-id> "try different approach"

# Watch agent work in a tmux split pane
forge run --watch "implement feature X"

# Set a cost ceiling
forge run --max-budget 5.00 "implement feature X"

# Plan only (no implementation)
forge run --plan-only "design API for Y"

# Dry run (preview tasks + cost estimate)
forge run --dry-run "implement feature X"

# Configurable max turns (default: 100)
forge run --max-turns 150 "large task"

# Verbose output (full streaming details)
forge run -v "debug issue Z"

# Quiet mode (for CI, minimal output)
forge run -q "implement feature X"
```

### Audit

Review a codebase against spec acceptance criteria. Produces new specs for any remaining work — output feeds directly into `forge run --spec-dir`.

```bash
forge audit specs/                          # Audit, output to specs/audit/
forge audit specs/ -C ~/target-repo         # Audit a different repo
forge audit specs/ -o ./remediation/        # Custom output directory
forge audit specs/ "focus on auth module"   # With additional context
```

### Review

Review uncommitted git changes for issues, blindspots, and suggestions.

```bash
forge review                                # Review current changes
forge review -C ~/other-repo               # Review a different repo
```

### Watch

Live-tail a running session's stream log with ANSI-colored output.

```bash
forge watch                                 # Watch latest session
forge watch <session-id>                    # Watch specific session
forge watch -C ~/other-repo                # Watch session in another repo
```

### Status

View results from recent runs.

```bash
forge status                                # Latest run
forge status --all                          # All runs
forge status -n 5                           # Last 5 runs
forge status -C ~/other-repo               # Different repo
```

## How It Works

1. **Prompt construction** — wraps user prompt in outcome-focused template with acceptance criteria
2. **Agent execution** — single SDK `query()` call; the agent decides its own approach
3. **Streaming** — real-time progress output via `includePartialMessages`
4. **Parallel execution** — worker pool runs specs concurrently with auto-tuned concurrency, braille spinner showing per-spec status and live tool activity
5. **Sequential-first** — optionally run foundation specs sequentially before parallelizing the rest (`--sequential-first N`)
6. **Verification** — auto-detects project type, runs build/test commands, feeds errors back for up to 3 fix attempts
7. **Cost tracking** — per-spec and total cost in batch summary, with optional `--max-budget` ceiling
8. **Result persistence** — saves structured metadata and full result text to `.forge/results/`
9. **Session persistence** — stream logs in `.forge/sessions/` enable resume, fork, and live tailing
10. **Rerun failed** — `--rerun-failed` finds and reruns only failed specs from the latest batch
11. **Safety** — bash guardrails block destructive commands, audit log tracks all tool calls
12. **Resilience** — auto-retries rate limits and network errors with exponential backoff; session persistence for resume on interrupt

## Configuration

```bash
# Option 1: Direct API key
export ANTHROPIC_API_KEY=sk-ant-...

# Option 2: Vercel AI Gateway
export VERCEL_AI_GATEWAY_URL=https://...
export VERCEL_AI_GATEWAY_KEY=vck_...
```

Project-level configuration in `.forge/config.json`:

```json
{
  "maxTurns": 100,
  "maxBudgetUsd": 10.00
}
```

## Works With

- [Bonfire](https://github.com/vieko/bonfire) — Session context persistence. Use `/bonfire spec` to create specs, then run them with Forge.

## Development

```bash
bun run src/index.ts run "test task"  # Dev mode
bun run typecheck                      # Type check
bun run build                          # Build
bun test                               # Run tests
```

## License

MIT
