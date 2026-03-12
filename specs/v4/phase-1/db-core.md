---
---

# Core Database Layer

## Outcome

Forge has a `.forge/forge.db` SQLite database created via `bun:sqlite` with WAL mode enabled, a schema versioning system with sequential migrations, and lazy initialization on first access. The database is gitignored and local-only — it indexes and extends filesystem state, it does not replace git-committed files.

## Acceptance Criteria

- `.forge/forge.db` created using `bun:sqlite` (zero external dependencies)
- WAL mode enabled on database open (`PRAGMA journal_mode=WAL`) for concurrent readers + single writer
- `PRAGMA busy_timeout=5000` set on open — handles multi-process write contention gracefully (executor + pipeline may write concurrently)
- `PRAGMA wal_autocheckpoint=1000` to keep WAL file size bounded
- `schema_version` table tracks current version number; migrations are ordered `up` functions that run sequentially from current version to latest
- Database auto-created on first access via a `getDb(workingDir)` function (lazy initialization, not eager)
- `.forge/forge.db`, `.forge/forge.db-wal`, and `.forge/forge.db-shm` added to `.forge/.gitignore` (DB is local, never committed)
- Graceful degradation: if DB file is corrupt or `bun:sqlite` is unavailable, forge commands fall back to existing filesystem-based state with a warning (no hard crash)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/utils.ts` (ensureForgeDir, saveResult), `src/pipeline-state.ts` (FileSystemStateProvider, atomic writes, file locking)
- New file: `src/db.ts` — database module with `getDb()`, migration runner, schema version tracking
- `bun:sqlite` ships with Bun — no package.json dependency needed
- The `getDb()` function should cache the Database instance per working directory (singleton per cwd)
- Migration functions live in `src/db.ts` as an ordered array: `[{ version: 1, up: (db) => ... }, ...]`
- All tables created by later specs (runs, tasks, sessions, pipelines) will add their own migrations — this spec only creates the infrastructure and the `schema_version` table
- Must work with the existing `.forge/.gitignore` auto-creation pattern in `ensureForgeDir()`
- Export a `getTestDb()` helper that returns an in-memory SQLite instance (`:memory:`) with all migrations applied — used by all DB test files for isolation
- DB tables are derived indexes, not sources of truth. `events.jsonl` is authoritative for session replay, `specs.json` is authoritative for spec lifecycle, `result.md` is authoritative for full result text
