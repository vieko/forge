---
depends: [tui-db.md]
---

# TUI Executor Visibility

Surface executor state and task queue in the TUI. The executor is infrastructure — it gets a status bar indicator and a tasks section, not a full tab.

## Acceptance Criteria

### Status Bar

1. **Executor indicator**: The TUI status bar (bottom of screen) shows executor state:
   - `executor: running (2 tasks)` — PID file exists, process alive, N tasks with status `running`
   - `executor: idle` — PID file exists, process alive, no running or pending tasks
   - `executor: stopped` — no PID file or process not alive
   Display updates on each `PRAGMA data_version` poll cycle (existing 1s interval).

2. **Color coding**: `running` in green, `idle` in dim/gray, `stopped` in yellow.

### Tasks Section in Sessions Tab

3. **Active tasks list**: Below the sessions list (or as a toggleable section via `t` key), show tasks from the DB `tasks` table with status `pending` or `running`:
   - Each row: `command (id short) — status — elapsed time`
   - Example: `audit (5e06e69e) — running — 2m 34s`
   - Sorted: running first, then pending, by creation time.

4. **Task detail**: Selecting a task and pressing Enter shows: full command, description, spec path, status, created/started timestamps, stdout/stderr tail (last 20 lines from `output` column), and linked session ID (if available).

5. **Task history**: Pressing `h` in the tasks section toggles showing completed/failed tasks from the last hour. Default: hidden (only active tasks shown).

### Controls

6. **Start executor**: Pressing `e` when executor is stopped spawns a detached executor (same logic as auto-spawn from `executor-auto-spawn.md`). Toast: `Executor started (PID: XXXXX)`.

7. **Stop executor**: Pressing `e` when executor is running sends SIGTERM to the PID from `.forge/executor.pid`. Toast: `Executor stopping...`. Status bar updates on next poll when PID file disappears.

8. **Guard on stop**: If tasks are running, show confirmation: `N task(s) running. Stop executor? (y/n)`. Stopping sends SIGTERM (graceful — executor waits up to 30s for running tasks).

### Data Source

9. **DB queries only**: All task data comes from the `tasks` table via existing DB functions (`getPendingTasks`, `getTaskById`). No new file watchers needed — `PRAGMA data_version` polling catches task table changes.

10. **Executor liveness**: Check via `isExecutorRunning()` (reads `.forge/executor.pid`, sends signal 0). Cached per poll cycle to avoid excessive filesystem reads.

### Executor Log Format

11. **Consistent executor logging for parallel tasks**: When `runForge()` runs inside the executor, the parallel runner's spinner display must not bleed through. The executor passes `quiet: true`, which already suppresses most output, but the parallel spinner bypasses quiet mode. Fix: the spinner respects `quiet` and the executor logs parallel task progress in its own format:

    ```
    [executor] > forge run (1f68b250) 3 specs [parallel]
    [executor]   + detect-package-manager.md (1f68b250)
    [executor]   + deps-manifest-aware.md (1f68b250)
    [executor]   x audit-fix-summary.md (1f68b250)
    [executor] + forge run (1f68b250): completed
    ```

    Per-spec lines appear as each spec finishes (`+` pass, `x` fail). This keeps the executor log scannable without losing visibility into what ran.

## Out of Scope

- Dedicated "Executor" or "Tasks" tab (keep it lightweight — revisit if task volume grows)
- Task creation from TUI (use MCP or CLI)
- Task cancellation from TUI (would require adding cancel support to executor first)
- Remote executor monitoring (phase 2)

## Key Files

- `src/tui.tsx` — status bar component, tasks section in SessionsList, keybindings
- `src/executor.ts` — reuse `isExecutorRunning()`, import `spawnDetachedExecutor()` from auto-spawn spec
- `src/db.ts` — may need `getRunningTasks()` or `getActiveTasks()` query if not already present
