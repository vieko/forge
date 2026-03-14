---
depends: [db-primary-architecture.md, test-harness-hermetic.md]
---

# DB is primary store for run results

## Outcome

The `runs` table is the single source of truth for run results. `saveResult()` writes to DB first; `summary.json` is removed; `backfillRuns()` is deleted. `showStatus()` and `showStats()` read exclusively from DB.

## Acceptance Criteria

- `saveResult()` in `src/utils.ts` inserts into the `runs` table as its primary action
- `summary.json` writes are removed entirely; `result.md` is written as a best-effort human-readable artifact (failure to write does not throw)
- `backfillRuns()` is deleted from `src/db.ts`
- `showStatus()` reads run data exclusively from the DB
- `showStats()` reads run data exclusively from the DB
- No regressions in `forge status` or `forge stats` output
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/utils.ts` — `saveResult()` currently dual-writes to filesystem + DB; make DB primary
- `src/db.ts` lines 568–855 — `backfillRuns()` to be removed
- `src/status.ts` — verify reads from DB; remove any filesystem fallback
- `src/stats.ts` — verify reads from DB; remove any filesystem fallback
- `src/run.ts` — result-saving flow; ensure it calls the updated `saveResult()`
- Keep `result.md` as optional human-readable artifact written after the DB insert
- Disaster recovery: document `sqlite3 .forge/forge.db .dump` as the backup path
