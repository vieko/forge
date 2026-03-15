---
depends: [db-primary-runs.md]
---

# Remove dead filesystem-based stats code

## Outcome

Dead code in `src/stats.ts` that reads `summary.json` from the filesystem is removed. Only the DB-backed query path remains.

## Acceptance Criteria

- `loadSummaries()` is removed from `src/stats.ts`
- `aggregateRuns()` is removed from `src/stats.ts` (superseded by `queryAggregateStats()` in db.ts)
- `computeModelStats()` is removed from `src/stats.ts` (superseded by `queryModelStats()` in db.ts)
- `filterSince()` is removed from `src/stats.ts` (superseded by DB `WHERE` clause)
- The `AggregatedStats` interface, `SpecStats` interface, `ModelStats` interface, and `computeSpecStats()` are removed if no longer referenced outside tests
- Tests in `stats.test.ts` that exercise the removed functions are deleted
- No other module imports the removed functions
- TypeScript compiles without errors
- All remaining tests pass

## Context

- `src/stats.ts` lines 47–71 — `loadSummaries()` reads `summary.json` files (unused by `showStats()`)
- `src/stats.ts` lines 85–116 — `aggregateRuns()` replaced by `queryAggregateStats()` in db.ts
- `src/stats.ts` lines 128–150 — `computeSpecStats()` replaced by `querySpecStats()` in db.ts
- `src/stats.ts` lines 162–190 — `computeModelStats()` replaced by `queryModelStats()` in db.ts
- `src/stats.ts` lines 201–203 — `filterSince()` replaced by `since` parameter in DB queries
- `src/stats.test.ts` — tests for the above functions should be removed
- Verify no other file imports these functions before deleting
