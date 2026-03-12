---
depends: [db-core.md]
---

# Sessions Index Table

## Outcome

Session metadata is indexed in a `sessions` table in forge.db, enabling fast queries like "all sessions for this spec" or "sessions in this pipeline" without scanning the `.forge/sessions/` directory. Event logs (events.jsonl) and stream logs (stream.log) remain as files on the filesystem.

## Acceptance Criteria

- `sessions` table with columns: `id` (TEXT PRIMARY KEY), `specPath`, `pipelineId`, `commandType`, `model`, `status`, `costUsd`, `startedAt`, `endedAt`
- Session row inserted into DB when `runQuery()` initializes a session (alongside existing `latest-session.json` write)
- Session row updated with `status`, `costUsd`, `endedAt` when session completes (success or error)
- Queries supported via SQL: filter by `specPath`, `pipelineId`, `commandType`; order by `startedAt DESC`
- `events.jsonl` files remain on filesystem (append-only logs are not DB material)
- `stream.log` files remain on filesystem
- Backfill: existing sessions populated from `.forge/results/*/summary.json` sessionId + metadata on first DB access
- TypeScript compiles without errors

## Context

- Relevant files: `src/core.ts` (runQuery — session init at ~line 288, session end at ~lines 449/526, latest-session.json write)
- Relevant types: `src/types.ts` (SessionStartEvent, SessionEndEvent, ForgeResult.sessionId)
- Current TUI session loading (`src/tui.tsx` loadSessions at ~line 313) scans directories and parses JSONL first lines — this becomes a single SQL query
- The `commandType` column maps to the `sessionExtra.type` field passed by callers (run, audit, define, proof, verify, review)
- Session ID comes from the SDK init message — written to DB at the same point as `latest-session.json`
- Backfill limitation: `pipelineId` and `commandType` are not stored in `summary.json` — backfilled rows will have these columns as NULL. This is acceptable; only new sessions get full metadata. Optionally, backfill can parse `events.jsonl` first lines to extract `session_start` event data for richer historical records
