---
depends: [db-tasks.md, executor-auto-spawn.md]
---

# Unified Task Tracking

All forge execution — CLI and MCP — writes to the `tasks` table. CLI runs execute directly (no executor hop) but record the same task lifecycle as MCP-queued work. This gives full observability over all work regardless of entry point.

## Problem

Today, CLI-initiated runs (`forge run`, `forge audit`, etc.) bypass the `tasks` table entirely. They write to `runs` and `sessions` but create no task record. This causes:

1. **Invisible work** — TUI task views, `forge stats`, and MCP `forge_task` only see executor-dispatched work
2. **Stuck manifest state** — cancelled CLI batches leave specs as `running` with no task record to detect the abandonment (no `markStaleTasks` equivalent for CLI)
3. **No cancellation tracking** — CLI Ctrl-C leaves no record that work was attempted and cancelled
4. **Split observability** — CLI and MCP runs have different data shapes, making aggregate reporting incomplete

## Acceptance Criteria

### CLI Task Insertion

1. **Task record on start**: When `runSingleSpec()` or `runForge()` begins execution via CLI, insert a task row with status `running` (not `pending` — CLI executes immediately, no queue). Fields: `id`, `command`, `description`, `specPath`, `cwd`, `status: 'running'`, `pid: process.pid`, `createdAt`, `startedAt`.

2. **Task record on completion**: On success, update the task to `completed` with `exitCode: 0`. On failure, update to `failed` with error message. On cancellation (abort signal), update to `cancelled`.

3. **Batch task**: For `runForge()` (parallel/sequential multi-spec), insert one parent task for the batch and one child task per spec. Parent task tracks overall batch status. Child tasks reference `parentTaskId`.

4. **Session linking**: When `runQuery()` captures a session ID, update the task's `sessionId` field — same as the executor already does via directory snapshot.

### New `cancelled` Status

5. **Cancelled status**: Add `cancelled` as a valid task status. Distinct from `failed` — cancelled means the user intentionally stopped, failed means the work errored. The abort signal handler in `runSingleSpec` and `runForge` sets this status.

6. **Manifest cleanup on cancel**: When a task is marked `cancelled`, any specs it set to `running` in the manifest are reset to `pending`. This prevents the stuck-running-specs problem.

### MCP Path (No Change to Queue Semantics)

7. **MCP unchanged**: MCP `forge_start` still inserts tasks as `pending`. The executor still claims and runs them. The only difference: the task schema now supports `cancelled` status and `parentTaskId`.

### Schema Changes

8. **New columns on `tasks` table**:
   - `parentTaskId TEXT` — FK to parent batch task (null for standalone or parent tasks)
   - `source TEXT NOT NULL DEFAULT 'cli'` — `'cli'` or `'mcp'`, indicates entry point
   - `cancelledAt TEXT` — ISO timestamp when cancelled (null otherwise)

9. **Migration**: Schema version bump. New columns are nullable/defaulted so existing rows are unaffected.

### Stale Task Recovery

10. **CLI stale detection**: `markStaleTasks()` already handles executor tasks via PID liveness. Extend it to also mark CLI tasks (source = 'cli') as `failed` if their PID is no longer alive and status is `running`. This catches crashed CLI processes.

### Observability

11. **`forge status` includes tasks**: `forge status` shows recent tasks (both CLI and MCP) alongside run results. Cancelled tasks shown with a distinct indicator.

12. **`forge stats` includes source breakdown**: `forge stats` can optionally break down by source (`--by-source`): CLI vs MCP initiated.

## Out of Scope

- Changing execution path (CLI still runs directly, MCP still queues)
- Task creation from TUI
- Task cancellation from TUI (separate concern)
- Retroactive backfill of historical CLI runs as tasks

## Key Files

- `src/run.ts` — `runSingleSpec()`: insert/update task on start/complete/fail/cancel
- `src/parallel.ts` — `runForge()`: insert parent batch task + child tasks per spec
- `src/db.ts` — new columns, migration, `insertCliTask()`, `cancelTask()`, `getChildTasks()`
- `src/specs.ts` — manifest cleanup on cancel (reset `running` → `pending`)
- `src/status.ts` — include task records in status display
- `src/stats.ts` — optional `--by-source` breakdown
