---
depends: [db-core.md]
---

# Persistent Tasks Table

## Outcome

MCP task tracking is backed by a `tasks` table in forge.db instead of the in-memory `Map<string, Task>`. Task state survives MCP server restarts and is visible to all consumers (TUI, MCP, CLI). The MCP server's `forge_start` and `forge_task` tools read and write the database instead of the in-memory map.

## Acceptance Criteria

- `tasks` table with columns: `id` (TEXT PRIMARY KEY), `command`, `description`, `specPath`, `status` (pending/running/completed/failed/cancelled), `pid`, `sessionId`, `stdout` (last 50 lines as JSON array), `exitCode`, `cwd`, `createdAt`, `updatedAt`
- MCP `forge_start` inserts a task row into DB with status `running`, returns `task_id`
- MCP `forge_task` reads task status from DB instead of in-memory Map
- MCP `forge_watch` resolves sessionId from DB task row (no change to output format)
- Task state survives MCP process restarts — restarted MCP can read tasks created by previous instance
- Stale task cleanup via SQL: tasks with `status = 'running'` and `updatedAt` older than TTL are marked `failed` on next query
- In-memory `Map<string, Task>` and `cleanupStaleTasks()` removed from `src/mcp.ts`
- TypeScript compiles without errors

## Context

- Relevant files: `src/mcp.ts` (Task interface at ~line 30, tasks Map at ~line 47, forge_start at ~line 311, forge_task at ~line 448, MAX_BUFFER_LINES = 50, TASK_TTL_MS = 1 hour)
- The existing `Task` interface maps closely to the DB columns — `stdout: string[]` becomes a JSON-serialized TEXT column
- `pid` column enables liveness checks (`process.kill(pid, 0)`) for tasks from previous MCP instances
- The `updatedAt` column should be refreshed on every stdout line capture (heartbeat pattern)
- MCP `forge_start` still spawns child processes in this spec — the execution model change comes in `mcp-command-queue.md`
