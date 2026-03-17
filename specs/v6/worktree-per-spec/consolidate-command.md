---
depends: [worktree-persistent-lifecycle.md, work-group-id.md]
---

# Forge consolidate command for merging worktrees

## Outcome

A new `forge consolidate` command merges all `ready` worktrees from a work group into a single consolidation branch. Worktrees are merged in dependency order with incremental type-checking after each merge. A full test suite runs after all merges complete. On success, a PR to main is created.

## Acceptance Criteria

- `forge consolidate` discovers `ready` worktrees via work_group_id (auto-detected from most recent work group, or `--work-group <id>`)
- Creates a consolidation branch from main: `forge/consolidate/{work-group-id}`
- Merges worktrees in dependency order (uses `topoSort()` from `src/deps.ts`)
- Incremental type-check (`tsc --noEmit` or equivalent via `detectVerification`) after each merge
- If type-check fails after a clean merge (no git conflicts, but build breaks), an SDK agent is dispatched to fix the type errors (same pattern as conflict resolution: up to 2 retries with error feedback). If the agent cannot fix the type errors, the merge is rolled back with `git reset --hard HEAD~1` (safe because the consolidation branch is a local-only integration branch with no shared history), the worktree status transitions to `merge_failed` (merging->merge_failed, distinct from `paused` which is for git conflicts and `failed` which is for pre-consolidation failures), and its transitive dependents are skipped (same skip propagation as conflict resolution)
- Full verification (build + test) runs after all merges complete
- Creates PR to main via `gh pr create` on success
- Worktree status transitions: ready -> merging -> merged (for each merged worktree)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/deps.ts` (topoSort), `src/verify.ts` (detectVerification, runVerification), `src/utils.ts` (git operations), `src/db.ts` (worktrees table), `src/index.ts` (CLI registration)
- New file: `src/consolidate.ts` for the consolidation logic
- Git merge strategy: `git merge --no-ff <branch>` for each worktree branch
- The consolidation branch is a temporary integration branch; the PR targets main
- Work group auto-detection: find the most recent work group with `ready` worktrees
