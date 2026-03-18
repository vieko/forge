---
depends: [db-primary-runs.md]
---

# Migrate audit fix result tracking from summary.json to DB

## Outcome

The audit-fix loop in `src/audit.ts` reads run results from the `runs` DB table instead of `summary.json` files. `collectFixResults()` and fix cost estimation work correctly for runs created after the DB-primary migration.

## Acceptance Criteria

- `collectFixResults()` queries the `runs` table to determine per-spec fix statuses instead of reading `summary.json`
- Fix cost estimation (around line 590) queries the `runs` table instead of reading `summary.json`
- `forge audit --fix` correctly tracks fix results and costs across rounds using DB data
- No `summary.json` reads remain in `src/audit.ts`
- TypeScript compiles without errors
- All tests pass

## Context

- `src/audit.ts` lines 380–408 — `collectFixResults()` reads `summary.json` to map spec basenames to fix statuses
- `src/audit.ts` lines 584–596 — fix cost estimation reads `summary.json` to sum `costUsd`
- `src/db.ts` — `queryStatusRuns()` returns `specPath`, `status`, `costUsd`, `batchId` which can serve both use cases
- `saveResult()` no longer writes `summary.json`, so these reads find nothing for new runs
