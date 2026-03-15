---
depends: [db-primary-runs.md]
---

# Migrate TUI session loading from summary.json to DB

## Outcome

`loadSessionFromResult()` in `src/tui.tsx` loads session metadata from the `runs` or `sessions` DB table instead of reading `summary.json`. The TUI displays session information correctly for runs created after the DB-primary migration.

## Acceptance Criteria

- `loadSessionFromResult()` queries the DB for session metadata (status, model, cost, duration, startedAt, sessionId) instead of reading `summary.json`
- No `summary.json` reads remain in `src/tui.tsx`
- The TUI Specs tab correctly displays session history for specs with only DB-backed runs
- Graceful degradation: if DB is unavailable, return null (existing behavior for read failure)
- TypeScript compiles without errors
- All tests in `tui.test.ts` and `tui-views.test.ts` updated and pass

## Context

- `src/tui.tsx` lines 706–727 — `loadSessionFromResult()` reads `summary.json` via `resultPath`
- `src/db.ts` — `querySessionsBySpec()` returns session rows; `runs` table has the same fields
- TUI already uses DB for sessions list via `queryAllSessions()` — this is a remaining filesystem fallback
- Test files `tui.test.ts` and `tui-views.test.ts` create `summary.json` fixtures that need migration
