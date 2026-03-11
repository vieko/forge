---
depends: [fs-watch-core.md]
---

# Replace Specs tab polling with fs.watch

## Outcome

The Specs tab in the TUI reloads the spec manifest reactively via `fs.watch` on `.forge/specs.json` instead of the current 5-second `setInterval` polling. Manifest changes appear in the TUI within ~100ms of the file being written.

## Acceptance Criteria

- The `setInterval(5000)` polling loop in `SpecsList` (around line 1201 of `tui.tsx`) is removed
- A `FileWatcher` from `src/file-watcher.ts` watches `.forge/specs.json` and triggers `loadManifest()` on change
- Initial load still happens immediately on mount (not deferred until first watch event)
- Fallback polling (10-30s) ensures the manifest is eventually refreshed even if fs.watch misses an event
- The watcher is disposed when the Specs tab unmounts or the TUI exits
- No duplicate `loadManifest()` calls from overlapping debounce and fallback timers
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/tui.tsx` — `SpecsList` component, `useEffect` with `setInterval` at ~line 1194
- Relevant files: `src/specs.ts` — `loadManifest()` at line 119, `saveManifest()` at line 129 (atomic write: tmp + rename)
- Watch target: `.forge/specs.json` (single file, ~36k, written atomically)
- The atomic write pattern (tmp file + rename) may produce 1-2 fs.watch events per save; debounce handles this
