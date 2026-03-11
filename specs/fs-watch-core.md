# Core debounced file watcher utility

## Outcome

A reusable `FileWatcher` module exists at `src/file-watcher.ts` that wraps Node's `fs.watch` with debouncing, platform-aware error recovery, configurable fallback polling, and a clean dispose API. All TUI views use this module instead of raw `setInterval` for file-change detection.

## Acceptance Criteria

- `createFileWatcher(path, callback, options)` function exported from `src/file-watcher.ts`
- Debounce window configurable via `options.debounceMs` (default 50-100ms); rapid fs.watch events coalesced into a single callback invocation
- Fallback polling at configurable `options.fallbackIntervalMs` (default 15000ms) fires the callback on a safety-net timer in case fs.watch silently drops events
- `options.type` supports `'file'` and `'directory'` to handle both single-file and directory watches
- Watcher recovers gracefully from `EPERM`, `EACCES`, `ENOENT`, and `EMFILE` errors — logs a warning and falls back to polling-only mode without crashing
- `dispose()` method on the returned handle clears all timers, closes the fs.watch handle, and prevents further callback invocations
- Works on macOS (kqueue) and Linux (inotify) — no platform-specific branching required at the call site
- Unit tests in `src/file-watcher.test.ts` cover: debounce coalescing, fallback polling trigger, error recovery to polling-only mode, dispose cleanup
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/watch.ts` (existing hybrid fs.watch + polling pattern at lines 170-188 — use as reference)
- Relevant files: `src/tui.tsx` (consumer of the new utility — all `setInterval` polling will migrate to this)
- Node's `fs.watch` is not 100% reliable across platforms; the fallback polling is essential as a safety net
- macOS kqueue reports directory-level changes but not always which file changed; Linux inotify is more granular
- The debounce prevents rapid-fire re-reads when a file is written atomically (tmp + rename = 2 events)
- Keep the API minimal — a single factory function returning a disposable handle
