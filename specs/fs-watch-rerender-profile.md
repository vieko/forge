# Profile and validate OpenTUI re-render cost under fs.watch

## Outcome

A benchmark exists that measures OpenTUI re-render duration under rapid update scenarios, confirming that fs.watch-triggered reloads do not degrade TUI responsiveness. Debounce intervals are validated against measured render times.

## Acceptance Criteria

- A profiling script or test at `src/file-watcher-bench.ts` measures re-render latency when data changes trigger component updates at various frequencies (10ms, 50ms, 100ms, 500ms intervals)
- Measurements capture wall-clock time for: `loadManifest()` parse, `loadSessions()` scan, React reconciliation, and terminal write
- Results document the minimum safe debounce interval that keeps render time under 16ms (60fps equivalent) or the actual render budget for terminal UIs
- If re-render cost exceeds acceptable thresholds, the benchmark identifies which load function is the bottleneck
- The chosen debounce interval in `fs-watch-core.md` is validated against these measurements
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/tui.tsx` — all components that re-render on data change
- Relevant files: `src/specs.ts` — `loadManifest()` parses ~36k JSON
- Relevant files: `src/tui.tsx` — `loadSessions()` scans two directories and reads metadata from multiple files
- OpenTUI uses a React reconciler with differential rendering — only changed nodes are rewritten to the terminal
- Scrollbox keying pattern (`key={count-runningCount}`) forces full reconciliation when counts change; profiling should capture this worst case
- The existing `watch.ts` uses 100ms polling successfully — this provides a baseline reference
