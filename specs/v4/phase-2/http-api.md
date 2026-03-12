---
depends: [db-core.md, db-runs.md, db-tasks.md, db-sessions.md, db-pipelines.md, config.md]
---

# HTTP State API

## Outcome

`forge serve` is the user-facing entrypoint for managed local infrastructure. It starts the HTTP API (read-only data plane via `Bun.serve`), ensures the executor is available (supervisory process plane), and exposes health/state endpoints. Remote clients can view runs, specs, pipelines, sessions, and tasks, and stream live session events — enabling monitoring from any device on the network.

## Acceptance Criteria

- HTTP server using `Bun.serve` (zero external dependencies)
- REST endpoints: `GET /runs`, `/specs`, `/pipelines`, `/sessions`, `/tasks` with query parameters for filtering and pagination
- SSE endpoint (`GET /events`) for live state changes: new runs, task status updates, pipeline stage progress
- Session event streaming: `GET /sessions/:id/events` serves `events.jsonl` content with byte-range support for incremental reads
- Simple token-based auth: single bearer token configured via `FORGE_API_TOKEN` environment variable or `.forge/config.json`
- Startable via `forge serve` command (explicit) with configurable port (default: `3141`)
- `forge serve` ensures executor availability on startup: checks `.forge/executor.pid` liveness, starts executor subprocess if not running
- `GET /health` endpoint reports executor status (running/stopped, PID, uptime), API uptime, and DB status
- If executor dies, `forge serve` detects via PID liveness check (periodic poll) and restarts it
- `forge executor` remains the low-level primitive for advanced users and debugging — `forge serve` is the recommended entrypoint
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/db.ts` (getDb), `src/stats.ts` (aggregation patterns), `src/status.ts` (run grouping), `src/mcp.ts` (existing tool response formats)
- New file: `src/serve.ts` — HTTP server module
- New CLI command: `forge serve` registered in `src/index.ts`
- `Bun.serve` is built into Bun — no Express/Hono/Fastify dependency needed
- REST response format should match existing MCP tool responses where possible (reuse types)
- SSE events should use the same `PipelineEvent` and `SessionEvent` types from `src/pipeline-types.ts` and `src/types.ts`
- Data plane is read-only: REST/SSE endpoints read from DB, they do not write state or execute commands (that's the executor's job)
- Process plane is supervisory: `forge serve` owns executor lifecycle (start, health check, restart) but does not execute tasks itself
- Guard against unauthenticated access: return 401 if token is configured but not provided
