---
name: forge
description: >-
  Verification boundary CLI that delegates tasks to autonomous agents. Use when the user wants to run forge, execute specs,
  run specs in parallel, run pending specs, define specs from a description, resolve specs, audit code against specs,
  review changes, watch live logs, check run status, resume a session, or delegate complex multi-step work
  to an autonomous agent. Triggers include "forge run", "run this spec",
  "run specs in parallel", "run pending", "forge define", "define specs", "audit the codebase", "review changes",
  "forge watch", "forge status", "rerun failed", "resolve spec", "delegate this to forge".
  Do NOT use for simple edits you can make directly, questions that don't require implementation,
  or straightforward work in the current repo that doesn't need autonomous agent execution.
allowed-tools: Bash(forge:*)
metadata:
  version: 3.6.6
  author: vieko
---

# Forge

Delegate complex, multi-step development work to an autonomous agent that builds and verifies code.

## When to Use Forge

- The task targets a different repo (`-C ~/other-project`)
- The work is complex enough to benefit from autonomous agent execution with verification
- You have spec files describing outcomes to implement
- You want to run multiple specs in parallel

## Commands

### forge run

```bash
forge run "add auth middleware"                          # Simple task
forge run --spec specs/auth.md "implement this"          # With spec file
forge run --spec-dir ./specs/ -P "implement all"         # Parallel specs
forge run -C ~/other-repo "fix the login bug"            # Target different repo
forge run --rerun-failed -P "fix failures"               # Rerun failed specs
forge run --pending -P "implement pending"               # Run only pending specs
forge run --resume <session-id> "continue"               # Resume interrupted session
forge run --plan-only "design API for auth"              # Plan without implementing
forge "quick task"                                       # Shorthand (no 'run')
```

Important flags:
- `-s, --spec <path>` -- Spec file (shorthand resolves via manifest). Prompt becomes additional context.
- `-S, --spec-dir <path>` -- Directory of specs (shorthand resolves via known dirs). Runs each `.md` separately; use `-P` for parallel. Already-passed specs are skipped.
- `-P, --parallel` -- Run specs concurrently (auto-tuned concurrency).
- `-F, --force` -- Re-run all specs including already passed.
- `-B, --branch <name>` -- Run in an isolated git worktree on the named branch. Auto-commits on success, cleans up after.
- `--concurrency <n>` -- Override auto-detected parallelism (default: freeMem/2GB, capped at CPUs).
- `--sequential-first <n>` -- Run first N specs sequentially, then parallelize.
- `-C, --cwd <path>` -- Target repo directory.
- `-t, --max-turns <n>` -- Max turns per spec (default: 250).
- `-b, --max-budget <usd>` -- Max budget in USD per spec.
- `--plan-only` -- Create tasks without implementing.
- `--dry-run` -- Preview tasks and estimate cost without executing.
- `-v, --verbose` -- Full output detail.
- `-q, --quiet` -- Suppress progress output (for CI).
- `-w, --watch` -- Auto-split tmux pane with live logs.

### forge audit

Reviews codebase against specs. Produces new spec files for remaining work — feed them back into `forge run --spec-dir`.

```bash
forge audit specs/                              # Audit all specs in directory
forge audit specs/auth.md                       # Audit a single spec file
forge audit auth.md                             # Shorthand (resolves via manifest)
forge audit specs/ "focus on auth module"       # With additional context
forge audit specs/ -o ./remediation/            # Custom output dir
forge audit specs/ -C ~/target-repo             # Different repo
forge audit specs/ --watch                      # Auto-split tmux pane with live logs
```

### forge define

Analyzes codebase and generates outcome spec files from a high-level description. Closes the loop: `forge define` → `forge specs` → `forge run --spec-dir`.

```bash
forge define "build auth system"                # Generate specs in specs/
forge define "add rate limiting" -o specs/api/  # Custom output dir
forge define "refactor database" -C ~/project   # Different repo
```

### forge review

Reviews recent git changes for bugs and quality issues.

```bash
forge review                                    # Review main...HEAD
forge review HEAD~5...HEAD                      # Specific range
forge review --dry-run -o findings.md           # Report only, write to file
forge review -C ~/other-repo                    # Different repo
```

### forge watch

Live-tail session logs with colored output. Auto-follows to next session during batch runs; exits after final session or 60s timeout.

```bash
forge watch                                     # Watch latest session (auto-follows batch)
forge watch <session-id>                        # Watch specific session (no auto-follow)
forge watch -C ~/other-repo                     # Watch in different repo
```

### forge status

```bash
forge status                                    # Latest run
forge status --all                              # All runs
forge status -n 5                               # Last 5 runs
forge status -C ~/other-repo                    # Different repo
```

### forge specs

List tracked specs with lifecycle status. Specs are registered in `.forge/specs.json` as they're run.

```bash
forge specs                                     # List all tracked specs
forge specs --pending                           # Show only pending
forge specs --failed                            # Show only failed
forge specs --passed                            # Show only passed
forge specs --orphaned                          # Manifest entries with missing files
forge specs --untracked                         # .md files not in manifest
forge specs --add                               # Register all untracked specs
forge specs --add specs/new.md                  # Register specific spec by path/glob
forge specs --resolve game.md                   # Mark spec as passed without running
forge specs --unresolve game.md                 # Reset a spec back to pending
forge specs --check                             # Triage pending specs: auto-resolve already-implemented ones via Sonnet agent
forge specs --reconcile                         # Backfill from .forge/results/ history
forge specs --prune                             # Remove orphaned entries from manifest
```

## Important

**Never manually orchestrate parallel forge runs** (e.g. `forge run spec1.md & forge run spec2.md & wait`). Forge handles parallelism, dependency ordering, and skip-passed internally via `--spec-dir -P`. Manual orchestration bypasses the dependency graph, manifest tracking, and batch grouping.

**Always prefer `--spec-dir -P`** over running individual specs. It automatically:
- Skips already-passed specs (use `--force` to override)
- Resolves `depends:` frontmatter into a topological execution order
- Tracks all specs in a single batch with grouped cost reporting
- Auto-tunes concurrency based on available memory

**`--spec` takes exactly one file.** The prompt is always the last positional argument (a quoted string). Bare file paths without a flag are interpreted as the prompt, not as spec files. To run multiple specs, use `--spec-dir -P`.

**Shorthand resolution**: spec paths resolve automatically. `forge run --spec login.md` finds the spec via manifest lookup. `forge run --spec-dir gtmeng-580` finds `.bonfire/specs/gtmeng-580/`. Full paths always work too.

## Common Mistakes

```bash
# WRONG: bare paths without --spec are treated as the prompt string
forge run specs/auth.md specs/login.md

# WRONG: --spec only takes one file, not multiple
forge run --spec specs/auth.md specs/login.md "implement"

# WRONG: manually running specs one-by-one bypasses dependency ordering
forge run --spec specs/01-schema.md "implement" && forge run --spec specs/02-api.md "implement"

# RIGHT: put specs in a directory, use --spec-dir -P
forge run --spec-dir specs/ -P "implement all"

# RIGHT: single spec with --spec
forge run --spec specs/auth.md "implement this"
```

## Recipes

### Run all specs in a directory

```bash
forge run --spec-dir gtmeng-580 -P -C ~/dev/project "implement all"
# Shorthand paths resolve automatically (gtmeng-580 → .bonfire/specs/gtmeng-580/)
# Already-passed specs are skipped; deps on passed specs are treated as satisfied
```

### Run a subset of specs from a directory

If specs use `depends:` frontmatter, `--spec-dir -P` automatically runs only the ready ones in topological order. Dependent specs wait for their deps to pass — no need to cherry-pick individual specs.

```bash
# Specs declare their dependencies:
#   03-api.md has "depends: [01-schema.md, 02-models.md]"
# Forge resolves the graph — 01 and 02 run in parallel, 03 waits for both
forge run --spec-dir specs/feature/ -P "implement all"

# Already-passed specs are skipped automatically; their dependents still run
# Use --force to re-run everything including passed specs
forge run --spec-dir specs/feature/ -P --force "re-verify all"
```

### Spec-driven development

```bash
# 1. Write specs as .md files (see references/writing-specs.md)
# 2. Run them in parallel
forge run --spec-dir ./specs/ -P "implement all specs"
# 3. Rerun any failures
forge run --rerun-failed -P "fix failures"
# 4. Check results
forge status
```

### Triage pending specs

```bash
# See what's pending
forge specs --pending
# Auto-resolve specs that are already implemented in the codebase
forge specs --check
# Run whatever is still pending
forge run --pending -P "implement remaining"
```

### Dependency-aware execution

Specs can declare dependencies via YAML frontmatter. Independent specs run in parallel, dependent specs wait:

```yaml
---
depends: [01-database-schema.md, 02-api-models.md]
---
```

```bash
forge run --spec-dir ./specs/ -P "implement all"
# Automatically runs in topological order based on depends: declarations
```

### Foundation specs first, then parallelize

When not using `depends:`, number-prefix specs for ordering. Foundations run sequentially before the parallel phase:

```bash
forge run --spec-dir ./specs/ -P --sequential-first 2 "implement"
# Runs 01-*.md, 02-*.md sequentially, then 03+ in parallel
```

### Audit-then-fix loop

```bash
forge audit specs/ -C ~/project                 # Find gaps
forge run --spec-dir specs/audit/ -P -C ~/project "fix remaining"
```

### Resume or fork after interruption

```bash
forge run --resume <session-id> "continue"               # Pick up where you left off
forge run --fork <session-id> "try different approach"    # Branch from that point
```

## Deep-Dive References

| Reference | Load when |
|-----------|-----------|
| [writing-specs.md](references/writing-specs.md) | Writing spec files for forge to execute |
| [parallel-execution.md](references/parallel-execution.md) | Tuning concurrency, understanding cost, monitoring parallel runs |
