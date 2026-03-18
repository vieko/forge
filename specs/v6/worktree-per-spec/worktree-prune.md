---
depends: [worktree-persistent-lifecycle.md]
---

# Worktree prune for cleanup of merged and abandoned worktrees

## Outcome

A `forge worktree prune` command cleans up worktrees that have been merged or abandoned. Stale detection identifies worktrees that are no longer active. Pruning removes the git worktree, cleans up the branch, and updates the registry. A dry-run mode previews what would be pruned.

## Acceptance Criteria

- `forge worktree prune` removes worktrees with status `merged` or `cleaned`
- Stale detection: worktrees with status `running` whose `pid` column value is no longer alive (via `process.kill(pid, 0)`) are marked `failed`
- TTL-based stale detection: non-running worktrees older than configurable threshold (default 7 days) flagged for cleanup
- Git worktree removal: `git worktree remove <path>` followed by `git worktree prune`
- Branch cleanup: `git branch -d <branch>` for merged branches (not force-delete)
- Registry entry status updated to `cleaned`
- `--dry-run` flag shows what would be pruned without taking action
- `--force` flag allows pruning worktrees in any non-running status
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/utils.ts` (cleanupWorktree, existing git worktree operations), `src/db.ts` (worktrees table), `src/index.ts` (CLI registration)
- Follow existing stale detection patterns from `src/executor.ts` (markStaleTasks: PID liveness + TTL)
- Sibling directory cleanup: remove the `{project}-{spec-name}` directory
- Branch deletion uses `-d` (safe delete, requires merge) not `-D` (force delete) to prevent data loss
- Configurable TTL via `.forge/config.json` (same pattern as executor idle timeout)
