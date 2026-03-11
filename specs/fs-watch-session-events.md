---
depends: [fs-watch-core.md]
---

# Replace session events polling with fs.watch and adaptive fallback

## Outcome

The session detail view's incremental event loader uses `fs.watch` on the active session's `events.jsonl` instead of the current 500ms `setInterval` polling. Events appear in the TUI within ~100ms of being written. An adaptive fallback ensures reliability for long-running sessions.

## Acceptance Criteria

- The `setInterval(500)` polling loop in `useIncrementalEvents` (around line 653 of `tui.tsx`) is replaced with an fs.watch-triggered reload
- The existing incremental byte-offset reading pattern (`readerStateRef`, `loadEventsIncremental`) is preserved — only the trigger mechanism changes
- fs.watch watches the specific `events.jsonl` file for the selected session
- Adaptive fallback: a short polling interval (2-5s) remains as safety net while the session is running, extending to 15-30s when idle or completed
- The watcher switches to the new session's `events.jsonl` when the user navigates to a different session
- The previous session's watcher is disposed before creating a new one
- Handles the legacy `stream.log` fallback path (sessions without `events.jsonl` still work)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/tui.tsx` — `useIncrementalEvents` hook at lines 618-663, `loadEventsIncremental` at lines 523-611
- Watch target: `.forge/sessions/{sessionId}/events.jsonl` (append-only JSONL, written by `src/core.ts` via `fd.write()`)
- The append-only write pattern (`fs.open('a')` + `fd.write()`) produces frequent small writes during active sessions — fs.watch fires on each append
- The incremental reader tracks byte offsets and partial lines — it is already optimized for append-only reads
- Adaptive polling matters here because active sessions produce rapid writes while completed sessions are static
