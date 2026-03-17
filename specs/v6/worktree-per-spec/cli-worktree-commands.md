---
depends: [worktree-registry-schema.md, worktree-persistent-lifecycle.md]
---

# CLI commands for worktree management

## Outcome

A new `forge worktree` command group provides subcommands for listing, inspecting, and managing worktree status. Users can view all worktrees, check detailed status, and signal lifecycle transitions from the command line.

## Acceptance Criteria

- `forge worktree list` shows all worktrees: id, status, spec, branch, path, age
- `forge worktree list --status <status>` filters by worktree status
- `forge worktree list --work-group <id>` filters by work group
- `forge worktree status <id>` shows detailed info: full spec content, run history, cost, duration
- `forge worktree mark-ready <id>` transitions worktree to `ready` status (validates current status allows transition)
- Output format consistent with `forge specs` and `forge status` (ASCII, no emojis)
- `-C <dir>` flag supported for different working directory
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/index.ts` (CLI command registration via commander), `src/db.ts` (worktrees table CRUD), `src/display.ts` (ANSI constants, formatting)
- Follow existing CLI patterns: commander subcommand registration, ANSI color output, quiet mode support
- `mark-ready` is the primary user-driven lifecycle transition: signals worktree is ready for consolidation
- List output should show most recently updated worktrees first
