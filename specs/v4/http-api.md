---
depends: [db-core.md, db-runs.md, db-tasks.md, db-sessions.md, db-pipelines.md, config.md]
---

# HTTP State API

## Outcome

A lightweight HTTP server built with `Bun.serve` exposes forge state as read-only REST endpoints with SSE for live updates. Remote clients can view runs, specs, pipelines, sessions, and tasks, and stream live session events — enabling monitoring from any device on the network.

## Acceptance Criteria

- HTTP server using `Bun.serve` (zero external dependencies)
- REST endpoints: `GET /runs`, `/specs`, `/pipelines`, `/sessions`, `/tasks` with query parameters for filtering and pagination
- SSE endpoint (`GET /events`) for live state changes: new runs, task status updates, pipeline stage progress
- Session event streaming: `GET /sessions/:id/events` serves `events.jsonl` content with byte-range support for incremental reads
- Simple token-based auth: single bearer token configured via `FORGE_API_TOKEN` environment variable or `.forge/config.json`
- Startable via `forge serve` command (explicit) with configurable port (default: `3141`)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/db.ts` (getDb), `src/stats.ts` (aggregation patterns), `src/status.ts` (run grouping), `src/mcp.ts` (existing tool response formats)
- New file: `src/serve.ts` — HTTP server module
- New CLI command: `forge serve` registered in `src/index.ts`
- `Bun.serve` is built into Bun — no Express/Hono/Fastify dependency needed
- REST response format should match existing MCP tool responses where possible (reuse types)
- SSE events should use the same `PipelineEvent` and `SessionEvent` types from `src/pipeline-types.ts` and `src/types.ts`
- The server reads from the DB (read-only) — it does not write state or execute commands (that's the executor's job)
- Guard against unauthenticated access: return 401 if token is configured but not provided
