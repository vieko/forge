---
depends: [db-runs.md, db-tasks.md, db-sessions.md, db-pipelines.md]
---

# TUI Database Integration

## Outcome

The TUI loads all list-view data (specs, runs, sessions, pipelines, tasks) from database queries instead of filesystem scanning. File watchers are reduced to only `events.jsonl` for live session event streaming. Data loading is faster and the code is simpler — SQL queries replace glob + JSON.parse loops.

## Acceptance Criteria

- Sessions list loaded from `sessions` table query instead of directory scanning + JSONL first-line parsing
- Runs/results loaded from `runs` table query instead of `.forge/results/*/summary.json` glob + parse
- Pipeline state loaded from `pipelines`/`stages`/`gates` tables via `SqliteStateProvider` instead of `pipeline.json` file read
- Tasks list (if displayed) loaded from `tasks` table query
- `events.jsonl` file watchers retained for live event streaming in session detail view (incremental byte-offset reading unchanged)
- DB change detection: poll via `PRAGMA data_version` query (returns an integer that increments on any write, even in WAL mode) instead of multiple `createFileWatcher()` instances on individual files. Do NOT rely on `forge.db` file mtime — WAL mode writes to `forge.db-wal`, so the main file's mtime only updates on checkpoint
- Specs list still loaded from `.forge/specs.json` manifest (specs.json stays as the source of truth per project constraints)
- TypeScript compiles without errors

## Context

- Relevant files: `src/tui.tsx` (loadSessions at ~line 313, incremental event loading at ~line 512, file watcher setup throughout), `src/file-watcher.ts` (createFileWatcher API)
- Current TUI uses 6+ file watchers: `specs.json`, `.forge/sessions/`, `.forge/results/`, `events.jsonl`, `pipeline.json`, `latest-session.json`
- With DB, most of these collapse into a single `PRAGMA data_version` poll (~1s interval) — only `events.jsonl` watcher remains for live streaming and `specs.json` watcher for manifest changes
- The `useIncrementalEvents` hook (byte-offset JSONL reader) is unchanged — it's already efficient for append-only log streaming
- DB queries can return pre-sorted, pre-filtered data (e.g. `ORDER BY startedAt DESC LIMIT 50`) — no in-memory sorting needed
- Consider a `useDbQuery<T>(sql, params, deps)` hook that re-fetches when `PRAGMA data_version` changes (compare previous value, re-query only on increment)
- DB tables are derived indexes — `events.jsonl` remains authoritative for session replay. The DB is never the source of truth for event data
