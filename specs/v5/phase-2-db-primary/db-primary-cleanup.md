---
depends: [db-primary-pipeline-provider.md]
---

# Remove dead backfill code and filesystem fallbacks

## Outcome

All backfill scaffolding, `getDbWithBackfill()`, `ensureSessionsBackfill()`, and remaining filesystem fallback paths are removed. `getDb()` is the only DB accessor. The codebase is clean after the DB-primary migration.

## Acceptance Criteria

- `getDbWithBackfill()` is removed; all call sites use `getDb()` directly
- `ensureSessionsBackfill()` is removed
- No remaining dual-write paths or filesystem-fallback reads for runs, sessions, or pipeline state
- Full test suite passes with no regressions after the removals
- TypeScript compiles without errors
- (Optional) A `forge db export` subcommand or documented `sqlite3 .forge/forge.db .dump` recovery path is present

## Context

- `src/db.ts` — remove `getDbWithBackfill()`, `ensureSessionsBackfill()`, and any remaining backfill helpers
- `src/tui.tsx` — verify no remaining filesystem fallback paths after prior specs
- `src/index.ts` — optional: add a `db export` subcommand for disaster recovery
- This spec is a sweep/cleanup pass; the substantive changes were in the three preceding specs
- Run `bun run typecheck` and the full test suite as the primary validation
