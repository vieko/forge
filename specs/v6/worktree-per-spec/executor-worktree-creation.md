---
depends: [sibling-worktree-creation.md]
---

# Executor creates worktrees on task claim

## Outcome

When the executor claims a task that requires worktree isolation, it creates the worktree at claim time (not at queue time). This centralizes worktree lifecycle management in the executor and ensures worktrees are only created when work actually begins.

## Acceptance Criteria

- Tasks queued via MCP `forge_start` can include a `worktree` intent flag in params (JSON)
- Executor's `dispatchTask()` creates the worktree when claiming a task with worktree intent
- Worktree path stored in the task record's params after creation
- Executor sets worktree status to `created` then `running` on task start, recording `pid` and `task_id` in the worktree row
- Executor sets worktree status to `complete` on task success, `failed` on failure (with error message in `error` column)
- Executor links `session_id` to the worktree row after SDK session starts (via `linkWorktreeSession`)
- If worktree creation fails, task is marked as `failed` with the error
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/executor.ts` (dispatchTask, pollLoop, task claiming), `src/utils.ts` (createWorktree), `src/db.ts` (tasks table, worktrees table), `src/mcp.ts` (forge_start tool)
- Current executor dispatch calls runForge/runSingleSpec/runAudit directly -- worktree creation is added before the dispatch call
- The executor already has access to the DB for task CRUD; it uses the same DB for worktree registry
- Task params JSON field already supports arbitrary typed params; worktree intent is a new boolean + optional spec_path/linear_issue_id
