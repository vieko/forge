---
depends: [db-primary-runs.md]
---

# Migrate reconcileSpecs() from summary.json to DB

## Outcome

`reconcileSpecs()` in `src/specs.ts` queries the `runs` table instead of scanning `summary.json` files from `.forge/results/`. Manifest backfill works for runs created after the DB-primary migration.

## Acceptance Criteria

- `reconcileSpecs()` queries the `runs` table for rows with a non-null `specPath` instead of reading `summary.json`
- No `summary.json` reads remain in `reconcileSpecs()`
- `forge specs --reconcile` correctly backfills manifest entries from DB run history
- Graceful degradation: if DB is unavailable, return 0 (no backfill) with no crash
- TypeScript compiles without errors
- All tests pass

## Context

- `src/specs.ts` lines 251–299 — `reconcileSpecs()` scans `.forge/results/*/summary.json` files
- `src/db.ts` — `runs` table has `specPath`, `status`, `costUsd`, `durationSeconds`, `batchId`, `createdAt`
- The manifest lock and entry CRUD functions are already in `src/specs.ts` and remain unchanged
- `saveResult()` no longer writes `summary.json`, so new runs have no `summary.json` to reconcile from
