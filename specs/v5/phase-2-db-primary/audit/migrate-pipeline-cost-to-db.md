---
depends: [db-primary-runs.md]
---

# Migrate pipeline stage cost estimation from summary.json to DB

## Outcome

The pipeline cost estimation in `src/pipeline.ts` queries the `runs` table instead of reading `summary.json` files. Pipeline stage costs are accurately tracked for runs created after the DB-primary migration.

## Acceptance Criteria

- Stage cost estimation queries the `runs` table (e.g., summing `costUsd` for runs since the stage started) instead of reading `summary.json`
- No `summary.json` reads remain in `src/pipeline.ts`
- Pipeline status correctly reports per-stage costs using DB data
- TypeScript compiles without errors
- All tests pass

## Context

- `src/pipeline.ts` lines 140–163 — reads `summary.json` to sum `costUsd` for runs created after a cutoff timestamp
- `src/db.ts` — `queryAggregateStats()` already supports a `since` parameter; may need a lighter query for stage-scoped cost
- `saveResult()` no longer writes `summary.json`, so new runs have no cost data at this path
