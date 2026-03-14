---
depends: [db-primary-cleanup.md]
---

# TaskContext abstraction replaces _skipTaskTracking flag

## Outcome

`runSingleSpec()` accepts a `TaskContext` interface instead of `_skipTaskTracking` / `_taskId` / `_parentTaskId` flags. Three implementations handle DB writes, executor delegation, and no-op (tests). The band-aid flag is gone.

## Acceptance Criteria

- A `TaskContext` interface is defined in `src/task-context.ts` with `updateStatus()`, `linkSession()`, and `cancel()` methods
- `DbTaskContext` — creates and manages its own task row in the DB (used by CLI path)
- `ExecutorTaskContext` — delegates to the executor's existing task row (used when called from executor)
- `NoopTaskContext` — does nothing (used in tests or when DB is unavailable)
- `runSingleSpec()` accepts `taskContext: TaskContext` instead of `_skipTaskTracking`, `_taskId`, `_parentTaskId`
- `_skipTaskTracking` field is removed from `ForgeOptions` in `src/types.ts`
- CLI entry in `src/index.ts` creates and passes `DbTaskContext`
- Executor in `src/executor.ts` creates and passes `ExecutorTaskContext` wrapping the existing MCP task
- `runForge()` in `src/parallel.ts` creates `DbTaskContext` for batch parent and passes child contexts to `runSingleSpec`
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/run.ts` — `runSingleSpec()` currently uses `_skipTaskTracking` (line 93), `_taskId`, `_parentTaskId` flags; refactor to accept `taskContext`
- `src/types.ts` — remove `_skipTaskTracking` from `ForgeOptions`
- `src/parallel.ts` — `runForge()` task lifecycle; pass child `TaskContext` instances
- `src/executor.ts` — create `ExecutorTaskContext` at dispatch time
- `src/index.ts` — create `DbTaskContext` at CLI invocation time
- New file: `src/task-context.ts` — interface + three implementations
