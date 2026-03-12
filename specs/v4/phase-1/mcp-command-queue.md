---
depends: [db-tasks.md]
---

# MCP Command Queue Pattern

## Outcome

The MCP server no longer spawns child processes directly. Instead, MCP tools insert task rows into the database with status `pending`, and a separate executor process picks up pending tasks, runs them, and writes results back to the database. The database is the coordination layer between MCP and execution.

## Acceptance Criteria

- MCP `forge_start` inserts a task row with status `pending` (no `spawn()` call, no child process management)
- Executor is a long-running daemon process started via `forge executor` CLI command
- Executor polls the `tasks` table for `status = 'pending'` rows, picks them up, and executes via direct function import (`runSingleSpec`, `runAudit`, etc.) — not CLI spawn (avoids reintroducing process management)
- Executor updates task status to `running` on pickup, streams stdout to DB, and marks `completed` or `failed` on finish
- `stripClaudeEnv()`, `.unref()` on child processes, and PID liveness checks removed from MCP server
- MCP `forge_task` polls DB for task status (interface unchanged — callers see no difference)
- Executor handles concurrent task execution with configurable concurrency limit (default: 2)
- Executor writes its PID to `.forge/executor.pid` on startup; MCP can check liveness and warn if no executor is running
- MCP `forge_start` checks for running executor (PID file + liveness) — if no executor detected, returns an error message with the command to start one: `forge executor` or `forge serve`
- Pipeline orchestrator (`pipeline.ts`) continues to execute stages directly (not through the executor) — pipelines are already long-running processes that own their execution. The executor handles MCP-initiated ad-hoc tasks only
- TypeScript compiles without errors

## Context

- Relevant files: `src/mcp.ts` (stripClaudeEnv at ~line 74, spawn logic at ~line 311, PID liveness at ~line 798)
- New file: `src/executor.ts` — long-running daemon that watches the tasks table and executes forge functions directly
- The executor runs outside Claude Code context, so `CLAUDECODE=1` is not set and `guardNestedSession()` does not trigger — eliminates the need for `stripClaudeEnv()`
- Direct function import (not CLI spawn): executor imports and calls `runSingleSpec`, `runAudit`, `runDefine`, etc. directly — faster execution, shared DB connection, no serialization overhead
- Polling interval for pending tasks: ~1 second (fast pickup without busy-waiting). Future optimization: `PRAGMA data_version` or Unix socket notify to avoid polling
- `forge serve` (phase 2, http-api.md) will supervise the executor — ensuring availability, reporting health, restarting if needed. For phase 1, `forge executor` is the standalone entrypoint
- Pipeline orchestrator keeps its own execution model — it's already a long-running process that spawns stages directly. The executor is for MCP-initiated tasks (run, audit, define, etc.) where there's no persistent process to own execution. These are two distinct patterns: daemon (executor) vs orchestrator (pipeline)
- SQLite write contention: executor and pipeline may write concurrently. Use `PRAGMA busy_timeout = 5000` in `getDb()` to handle WAL write locks gracefully (SQLite retries internally for up to 5 seconds)
- The executor pattern also enables future job scheduling, priority queues, and rate limiting
