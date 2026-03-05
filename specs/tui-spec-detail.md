---
depends: [tui-specs-list.md]
---

# Spec detail view with run history and session drill-down

## Outcome

Pressing Enter on a spec in the Specs list opens a detail view showing that spec's metadata and full run history. From the run history the user can drill into the existing `SessionDetail` view for any individual run. Back-navigation returns to the correct previous screen.

## Acceptance Criteria

- Pressing `Enter` on a selected spec in `SpecsList` navigates to a `SpecDetail` component
- `SpecDetail` renders: spec path, current status (icon + label), source origin, `createdAt` and `updatedAt` formatted via `formatRelativeTime`
- A run history section lists all `SpecRun` entries newest-first; each row shows: status icon, relative timestamp, cost, duration, turn count (`numTurns`), verify attempts (`verifyAttempts`)
- Pressing `up` / `k` and `down` / `j` navigates between runs in the history list
- Pressing `Enter` on a run navigates to the existing `SessionDetail` view for that run's session (derive `eventsPath` from `run.resultPath` using `deriveEventsPath` already in `tui.tsx`)
- Pressing `Escape` / `Backspace` from `SessionDetail` (when reached via a spec run) returns to `SpecDetail`, not the Sessions list
- Pressing `Escape` / `Backspace` from `SpecDetail` returns to `SpecsList` with the previous selection preserved
- An empty state ("No runs yet") is shown when `entry.runs` is empty
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/tui.tsx` — add `SpecDetail` component; extend App nav state to track `specDetailEntry`, `specDetailRunIndex`, and a `returnTo` discriminator so `SessionDetail` knows whether back-nav goes to Sessions list or Spec detail
- `src/types.ts` — `SpecEntry`, `SpecRun { runId, timestamp, resultPath, status, costUsd?, durationSeconds, numTurns?, verifyAttempts? }`
- `deriveEventsPath(logPath?, sessionId?, cwd?)` in `tui.tsx` resolves `run.resultPath` to an `eventsPath` for `SessionDetail`; `sessionId` can be derived from the result directory name (last segment of `resultPath`)
- `SessionDetail` already accepts `session: SessionInfo`; construct a minimal `SessionInfo` from the `SpecRun` fields (`isRunning: false`, `status` mapped from run status)
- Helper functions to reuse: `formatCost`, `formatDuration`, `formatRelativeTime`, `pad`, `truncate`, status colour constants
- Keep `SessionDetail` unchanged — only the calling site and back-nav routing change
