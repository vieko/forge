---
depends: [db-primary-runs.md]
---

# DB is primary store for session metadata

## Outcome

The `sessions` table is the single source of truth for session metadata. Session creation writes to DB first. `backfillSessions()` is deleted. The TUI's filesystem fallback path for session loading is removed. `events.jsonl` is retained as an append-only event log for streaming.

## Acceptance Criteria

- Session creation in `src/core.ts` writes to the `sessions` table as its primary action
- `backfillSessions()` is deleted from `src/db.ts`
- `queryAllSessions()` is the single query path for session data in the TUI
- The TUI's filesystem-based session loading fallback (when DB is unavailable) is removed from `src/tui.tsx`
- `events.jsonl` is preserved as an append-only streaming log; `forge watch` continues reading it directly
- No regressions in TUI session display or `forge watch`
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/db.ts` — `backfillSessions()` (~120 lines) to be removed
- `src/tui.tsx` — remove filesystem-based session loading fallback; `queryAllSessions()` is the only path
- `src/core.ts` — session creation; ensure DB write happens here
- `src/run.ts` — session lifecycle; verify consistent with DB-primary flow
- `events.jsonl` is not dual-write; it's a separate streaming concern — leave it untouched
