---
depends: [db-core.md, http-api.md, config.md]
---

# Multi-Device Sync Layer

## Outcome

A `DbProvider` interface abstracts all database access so the underlying engine can be swapped without changing application code. The default `BunSqliteProvider` wraps `bun:sqlite` for local-only use. A `TursoProvider` using `libsql` enables cloud replication — local reads stay fast while writes replicate to Turso, and other devices connect to the cloud endpoint for read access.

## Acceptance Criteria

- `DbProvider` interface abstracts all database operations: `query()`, `run()`, `get()`, `transaction()`, schema migration
- `BunSqliteProvider` implements `DbProvider` using `bun:sqlite` (default, zero dependencies)
- `TursoProvider` implements `DbProvider` using `@libsql/client` with embedded replica mode (local reads, cloud writes)
- Provider selection via `FORGE_DB_PROVIDER` environment variable or `.forge/config.json` (`"dbProvider": "sqlite" | "turso"`)
- Turso configuration: `FORGE_TURSO_URL` and `FORGE_TURSO_AUTH_TOKEN` environment variables for cloud endpoint
- All existing DB consumers (`getDb()`, stats, status, MCP, TUI) use the `DbProvider` interface — no direct `bun:sqlite` imports outside the provider
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/db.ts` (getDb function from db-core.md), `src/pipeline-types.ts` (StateProvider interface — existing pattern for swappable providers)
- New files: `src/db-provider.ts` (DbProvider interface), `src/db-sqlite.ts` (BunSqliteProvider), `src/db-turso.ts` (TursoProvider)
- The `StateProvider` interface in pipeline-types.ts is the existing precedent — designed for "filesystem, Postgres, and Redis implementations" per its comments
- `@libsql/client` is the only external dependency introduced — and only when Turso is configured (dynamic import)
- Embedded replica mode: Turso syncs a local SQLite file that serves reads, writes go through the cloud — combines local speed with remote access
- The HTTP State API from `http-api.md` provides read-only access for devices that don't need the full Turso setup
- Design for gradual adoption: start with `BunSqliteProvider` (zero config), upgrade to `TursoProvider` when multi-device is needed
