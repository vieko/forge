---
depends: [fs-watch-core.md]
---

# Replace Sessions list polling with fs.watch

## Outcome

The Sessions list in the TUI detects new, completed, and running sessions reactively via `fs.watch` on the relevant directories instead of the current 2-second `setInterval` polling. New sessions and status changes appear in the TUI within ~100ms.

## Acceptance Criteria

- The `setInterval(2000)` polling loop for sessions (around line 2216 of `tui.tsx`) is removed
- Directory watchers from `src/file-watcher.ts` watch `.forge/sessions/` and `.forge/results/` for new or changed entries
- A file watcher watches `.forge/latest-session.json` for session start/resume events
- `loadSessions()` is triggered on any watched change (debounced)
- Initial load still happens immediately on mount
- Fallback polling (10-30s) ensures sessions are eventually refreshed
- All watchers are disposed when the TUI exits
- Handles missing directories gracefully (e.g., `.forge/sessions/` may not exist on first run)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/tui.tsx` — `loadSessions()` at lines 312-462, polling `useEffect` at ~line 2216
- Watch targets: `.forge/sessions/` (new session dirs appear here), `.forge/results/` (completed session results), `.forge/latest-session.json` (single file, updated on session start)
- `loadSessions()` scans both directories and merges results — a single debounced callback handles all three watch sources
- Running session detection checks `events.jsonl` mtime (< 5 minutes old)
