---
depends: [db-pipelines.md, persist-routing.md]
---

# Worktree-First Pipeline Execution

## Outcome

Every `forge pipeline` automatically creates a dedicated git worktree for isolated execution. Multiple pipelines can run concurrently in separate worktrees with separate database rows. Worktrees are cleaned up on pipeline completion or cancellation, with rollback on creation failure.

## Acceptance Criteria

- `forge pipeline` creates a git worktree for each new pipeline (branch name derived from pipeline ID, e.g. `forge-<id>`)
- Pipeline record in DB stores `worktreePath` and `branch` (populated on creation)
- Multiple pipelines can run concurrently — each has its own worktree and its own DB row
- Worktree creation failure triggers immediate rollback (`git worktree remove`) and pipeline marked `failed`
- Worktree cleaned up automatically on pipeline completion or cancellation (via `cleanupWorktree`)
- Pipeline execution uses worktree as working directory; `persistDir` routes `.forge/` writes to the original repo
- `forge pipeline status` displays worktree path and branch for active pipelines
- TypeScript compiles without errors

## Context

- Relevant files: `src/utils.ts` (createWorktree, commitWorktree, cleanupWorktree at lines 141-231), `src/pipeline.ts` (runPipeline orchestrator), `src/core.ts` (QueryConfig.persistDir at line 30)
- Current worktree support exists via `--branch` flag on `forge run` — this makes it the default for pipelines
- The `persistDir` pattern is already established: when running in a worktree, session logs/results/specs route to the original repo's `.forge/` directory
- Existing `createWorktree()` uses `/tmp/forge-worktree-<branch>` paths — pipelines can use the same convention
- Concurrent pipeline isolation: each worktree is a separate git checkout, so file edits in one pipeline don't affect another
- The pipeline orchestrator (`runPipeline`) needs to wrap all stage execution with the worktree cwd and persistDir
