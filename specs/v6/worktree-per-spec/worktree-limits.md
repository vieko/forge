---
depends: [worktree-registry-schema.md]
---

# Worktree limits and disk quota enforcement

## Outcome

Forge enforces configurable limits on worktree count and total disk usage to prevent unbounded proliferation. When limits are exceeded, new worktree creation is blocked with a clear message suggesting `forge worktree prune`.

## Acceptance Criteria

- Max active worktrees configurable via `.forge/config.json` field `maxWorktrees` (default: 10). Active = status not in (cleaned)
- Max total worktree disk usage configurable via `.forge/config.json` field `maxWorktreeDiskMb` (default: 5000, i.e., 5GB)
- Before creating a worktree, check active count and total disk usage against limits
- If count limit exceeded: error with message listing active worktrees and suggesting `forge worktree prune`
- If disk limit exceeded: error with message showing current usage and suggesting `forge worktree prune`
- Disk usage calculated by summing directory sizes for ALL worktrees that still have a directory on disk (any status except `cleaned`), using `du -s` or equivalent
- `forge worktree list` shows current count and disk usage vs limits
- Limits can be overridden with `--force` flag on create operations
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/utils.ts` (createWorktree), `src/config.ts` (.forge/config.json schema), `src/db.ts` (worktrees table queries)
- Disk usage check is best-effort — if `du` fails, log a warning and skip the check (don't block creation)
- The default of 10 worktrees is generous for typical workflows (5 specs + their reruns); the default of 5GB accounts for large monorepos
- Limits apply per-project (scoped to the git repo root), not globally
- Both count and disk metrics include `merged` worktrees (they still have directories on disk until pruned). This ensures the disk metric and auto-cleanup operate on the same population — pruning `merged` worktrees actually reduces the measured disk usage
