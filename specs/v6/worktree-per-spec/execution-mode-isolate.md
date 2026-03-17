---
depends: [sibling-worktree-creation.md, worktree-persistent-lifecycle.md]
---

# Worktree-per-spec execution mode (--isolate)

## Outcome

A new `--isolate` flag on `forge run` creates one worktree per independent spec, enabling fully isolated parallel execution. Each spec runs in its own sibling directory worktree with its own branch. All worktrees share the same work group ID for later consolidation.

## Acceptance Criteria

- New `--isolate` flag added to `forge run` CLI command
- Each spec in `--spec-dir` gets its own worktree and branch
- All worktrees registered in DB with the same `work_group_id`
- Parallel execution across worktrees respects `--concurrency` limit
- Each worktree transitions independently: created -> running -> complete
- Batch summary shows per-worktree results (spec, status, cost, worktree path)
- Results from all worktrees persist to the original repo via `persistDir`
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/parallel.ts` (runForge, runForgeInner, workerPool), `src/run.ts` (runSingleSpec), `src/utils.ts` (createWorktree), `src/index.ts` (CLI flag parsing)
- In isolate mode, each worker in the pool creates its own worktree before calling runSingleSpec
- The `autoDetectConcurrency()` function determines how many worktrees run simultaneously
- This mode is opt-in; the default remains single-worktree for all specs
- Each worktree has its own verification context (tsc, build, test run in the worktree)
