---
depends: [db-primary-runs.md]
---

# Migrate findFailedSpecs() from summary.json to DB

## Outcome

`findFailedSpecs()` in `src/parallel.ts` queries the `runs` table instead of reading `summary.json` files. The `--rerun-failed` flag works correctly for runs created after the DB-primary migration.

## Acceptance Criteria

- `findFailedSpecs()` queries the `runs` table via `getDb()` to find the latest `batchId` and its failed specs
- No `summary.json` reads remain in `findFailedSpecs()`
- `forge run --rerun-failed` correctly identifies failed specs from the latest batch using DB data
- Graceful degradation: if DB is unavailable, throw a clear error (do not silently return empty)
- TypeScript compiles without errors
- Existing tests in `parallel.test.ts` updated to use DB fixtures instead of `summary.json` files
- All tests pass

## Context

- `src/parallel.ts` lines 592–629 — `findFailedSpecs()` currently reads `summary.json` from `.forge/results/`
- `src/db.ts` — `queryStatusRuns()` already returns runs with `batchId`, `status`, `specPath` (reusable or extend)
- `saveResult()` in `src/utils.ts` no longer writes `summary.json`, so `findFailedSpecs()` finds nothing for new runs
- `src/parallel.test.ts` lines 293–410 — tests that create `summary.json` fixtures need migration to DB
