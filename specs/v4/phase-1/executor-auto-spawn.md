---
depends: [db-tasks.md, mcp-command-queue.md]
---

# Executor Auto-Spawn

Auto-spawn the executor daemon when work is queued, with idle timeout for automatic shutdown. Eliminates the manual `forge executor` step — the executor becomes invisible infrastructure that exists when there's work and disappears when idle.

## Acceptance Criteria

1. **Lazy spawn from MCP**: When `forge_start` inserts a pending task and no executor is running (`isExecutorRunning()` returns false), spawn a detached executor process before returning the task ID. The MCP tool must not block on executor startup — spawn and return immediately.

2. **Lazy spawn from CLI**: When `forge run`, `forge audit`, `forge define`, `forge proof`, or `forge verify` detect they are being called via the task queue path (not direct execution), apply the same auto-spawn logic.

3. **Idle timeout**: The executor shuts itself down after 5 minutes (configurable via `FORGE_EXECUTOR_IDLE_TIMEOUT` env var or `.forge/config.json` `executorIdleTimeout`) of no pending or running tasks. The timer resets each time a new task is claimed or a running task completes.

4. **Detached process**: The auto-spawned executor runs as a detached child process (`stdio: 'ignore'`, `detached: true`, `unref()`). It must survive the parent MCP/CLI process exiting.

5. **PID file**: The existing `.forge/executor.pid` mechanism is reused. The auto-spawned executor writes its PID on startup, cleans up on shutdown. No changes to the liveness check.

6. **No double-spawn**: If two `forge_start` calls arrive simultaneously, only one executor spawns. The `isExecutorRunning()` check plus the existing duplicate guard in `startExecutor()` prevent races. A brief retry (check again after 500ms) handles the window between spawn and PID file write.

7. **Manual override**: `forge executor` still works for users who prefer explicit control. If an auto-spawned executor is already running, `forge executor` exits with the existing "already running" message.

8. **Quiet by default**: Auto-spawned executors run with `--quiet` since there's no terminal to print to. Manual `forge executor` remains verbose.

9. **Spawn feedback**: `forge_start` response includes `executor_spawned: true` when it auto-spawned, so the caller knows the executor was just started (first task may take slightly longer due to startup).

## Out of Scope

- Remote executor supervision (phase 2 http-api)
- Multi-executor coordination
- Auto-spawn from TUI (TUI reads DB directly, doesn't need executor for display)
- Changing the executor's poll interval or concurrency defaults

## Key Files

- `src/mcp.ts` — `forge_start` tool: add spawn logic before task insertion
- `src/executor.ts` — add idle timeout to main loop, add `spawnDetachedExecutor()` helper
- `src/config.ts` — add `executorIdleTimeout` field (default: 300000ms)
