---
depends: [worktree-prune.md, worktree-limits.md]
---

# Automatic disk cleanup when approaching worktree limits

## Outcome

When worktree disk usage approaches the configured limit, Forge automatically prunes the oldest `merged` worktrees to free space. This prevents hard failures during worktree creation by proactively reclaiming disk from completed work.

## Acceptance Criteria

- Before creating a new worktree, if disk usage exceeds 80% of `maxWorktreeDiskMb`, auto-prune `merged` worktrees oldest-first until below 80%
- Only auto-prune worktrees with status `merged` (safe to remove — work has been consolidated)
- If auto-pruning `merged` worktrees is insufficient to get below 80%, warn but proceed (don't auto-prune `complete`/`ready` worktrees — those may have unmerged work)
- Auto-prune logged to console with list of cleaned worktrees
- `forge worktree prune --auto` triggers the same logic manually
- Auto-cleanup is skippable with `--no-auto-prune` flag on create operations
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/utils.ts` (createWorktree), `src/db.ts` (worktrees table), `src/config.ts` (maxWorktreeDiskMb)
- The 80% threshold provides a buffer — creation can still succeed even if the new worktree exceeds the remaining 20%
- This is a convenience feature, not a hard guard — `worktree-limits.md` provides the hard guard
- Auto-pruning only removes `merged` worktrees because their changes are safely in the consolidation branch
- Ordering by `updated_at ASC` removes the oldest merged worktrees first
