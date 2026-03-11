---
depends: [fs-watch-core.md]
---

# Replace Pipeline tab polling with fs.watch

## Outcome

The Pipeline list and Pipeline detail views in the TUI detect state changes reactively via `fs.watch` instead of the current 2-second `setInterval` polling. Pipeline stage transitions, gate approvals, and cost updates appear within ~100ms.

## Acceptance Criteria

- The `setInterval(2000)` polling loop in `PipelinesList` (around line 1734 of `tui.tsx`) is removed
- The `setInterval(2000)` polling loop in `PipelineDetail` (around line 1915 of `tui.tsx`) is removed
- File watchers from `src/file-watcher.ts` watch `.forge/pipeline.json` and the `.forge/pipelines/` directory
- `FileSystemStateProvider.listPipelines()` is triggered on directory changes (debounced)
- `FileSystemStateProvider.loadPipeline(id)` is triggered on file changes in pipeline detail view
- Pipeline detail polling remains active only while `status === 'running' || 'paused_at_gate'` (same conditional as current implementation)
- Fallback polling (10-30s) ensures pipeline state is eventually refreshed
- All watchers are disposed on unmount or TUI exit
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/tui.tsx` — `PipelinesList` at ~line 1727, `PipelineDetail` at ~line 1853
- Relevant files: `src/pipeline-state.ts` — `FileSystemStateProvider` at line 204 (atomic write: tmp + rename)
- Watch targets: `.forge/pipeline.json` (active pipeline, written atomically), `.forge/pipelines/` (historical pipeline JSONs)
- The pipeline process writes state every 2s during gate polling — debounce prevents redundant reloads
