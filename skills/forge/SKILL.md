---
name: forge
description: >-
  Verification boundary CLI that delegates tasks to autonomous agents. Use when the user wants to run forge, execute specs,
  run specs in parallel, audit code against specs, review changes, watch live
  logs, check run status, resume a session, or delegate complex multi-step work
  to an autonomous agent. Triggers include "forge run", "run this spec",
  "run specs in parallel", "audit the codebase", "review changes",
  "forge watch", "forge status", "rerun failed", "delegate this to forge".
allowed-tools: Bash(forge:*)
metadata:
  version: 3.1.0
  author: vieko
---

# Forge

Delegate complex, multi-step development work to an autonomous agent that builds and verifies code.

## When to Use Forge

**Use forge when:**
- The task targets a different repo (`-C ~/other-project`)
- The work is complex enough to benefit from autonomous agent execution with verification
- You have spec files describing outcomes to implement
- You want to run multiple specs in parallel

**Don't use forge when:**
- The task is a simple edit you can make directly
- The user is asking a question, not requesting implementation
- The work is in the current file / current repo and straightforward

## Commands

### forge run

```bash
forge run "add auth middleware"                          # Simple task
forge run --spec specs/auth.md "implement this"          # With spec file
forge run --spec-dir ./specs/ -P "implement all"         # Parallel specs
forge run -C ~/other-repo "fix the login bug"            # Target different repo
forge run --rerun-failed -P "fix failures"               # Rerun failed specs
forge run --resume <session-id> "continue"               # Resume interrupted session
forge "quick task"                                       # Shorthand (no 'run')
```

Important flags:
- `-s, --spec <path>` -- Spec file. Prompt becomes additional context.
- `-S, --spec-dir <path>` -- Directory of specs. Each `.md` runs separately.
- `-P, --parallel` -- Run specs concurrently (auto-tuned concurrency).
- `--sequential-first <n>` -- Run first N specs sequentially, then parallelize.
- `-C, --cwd <path>` -- Target repo directory.
- `-w, --watch` -- Auto-split tmux pane with live logs.
- `--dry-run` -- Preview tasks and estimate cost without executing.

Run `forge run --help` for all flags.

### forge audit

Reviews codebase against specs. Produces new spec files for remaining work — feed them back into `forge run --spec-dir`.

```bash
forge audit specs/                              # Audit, output to specs/audit/
forge audit specs/ -o ./remediation/            # Custom output dir
forge audit specs/ -C ~/target-repo             # Different repo
```

### forge review

Reviews recent git changes for bugs and quality issues.

```bash
forge review                                    # Review main...HEAD
forge review HEAD~5...HEAD                      # Specific range
forge review --dry-run -o findings.md           # Report only, write to file
```

### forge watch

Live-tail session logs with colored output. Auto-exits when session completes.

```bash
forge watch                                     # Watch latest session
forge watch <session-id>                        # Watch specific session
```

### forge status

```bash
forge status                                    # Latest run
forge status --all                              # All runs
forge status -n 5                               # Last 5 runs
```

### forge specs

List tracked specs with lifecycle status. Specs are registered in `.forge/specs.json` as they're run.

```bash
forge specs                                     # List all tracked specs
forge specs --pending                           # Show only pending
forge specs --failed                            # Show only failed
forge specs --orphaned                          # Manifest entries with missing files
forge specs --untracked                         # .md files not in manifest
```

## Recipes

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
