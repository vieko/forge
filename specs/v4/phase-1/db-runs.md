---
depends: [db-core.md]
---

# Runs Table and Stats/Status Rewrite

## Outcome

Run results are persisted to an indexed `runs` table in forge.db alongside the existing filesystem storage. `forge stats` and `forge status` query the database with SQL instead of scanning directories and parsing JSON files. Existing results are backfilled into the DB on first access.

## Acceptance Criteria

- `runs` table with columns: `id` (TEXT PRIMARY KEY), `specPath`, `model`, `status`, `costUsd`, `durationSeconds`, `numTurns`, `toolCalls`, `batchId`, `type`, `prompt`, `cwd`, `sessionId`, `error`, `createdAt`
- `saveResult()` in `src/utils.ts` writes a row to the `runs` table alongside existing filesystem persistence (summary.json + result.md)
- `forge stats` rewritten to query `runs` table via SQL — `--by-spec` is `GROUP BY specPath`, `--by-model` is `GROUP BY model`, `--since` is `WHERE createdAt >= ?`
- `forge status` rewritten to query `runs` table grouped by `batchId` with `ORDER BY createdAt DESC` (no directory scanning)
- Backfill migration: on first DB access, existing `.forge/results/*/summary.json` files are imported into the `runs` table
- `result.md` files remain on filesystem only (full text content is not stored in DB)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/utils.ts` (saveResult at lines 233-273), `src/stats.ts` (loadSummaries, aggregateRuns, computeSpecStats, computeModelStats), `src/status.ts` (showStatus)
- Relevant types: `src/types.ts` (ForgeResult interface — maps directly to runs table columns)
- Current pattern: `loadSummaries()` reads all directories under `.forge/results/`, parses each `summary.json` — O(n) filesystem reads
- The `id` column should use the timestamp directory name (e.g. `2026-02-14T10-30-45-123Z`) for backward compatibility
- Backfill should be idempotent — running it multiple times produces the same result (INSERT OR IGNORE)
- Stats functions should fall back to filesystem scanning if DB is unavailable (graceful degradation from db-core)
- Dual-write (filesystem + DB) is a v4 migration strategy — v5 may drop filesystem-only read paths once DB reliability is proven. For now, both paths must work
