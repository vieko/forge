---
---

# Pipeline setup failure marks first stage as failed

## Outcome

When workspace setup fails before any pipeline stage runs, both the pipeline status and the first (`define`) stage status are set to `failed`. The TUI retry handler finds the failed stage and enables retry as expected.

## Acceptance Criteria

- When initial workspace setup fails, `pipeline.stages[0].status` is set to `'failed'` before `runPipeline` returns
- When resume-path workspace setup fails, `pipeline.stages[0].status` is set to `'failed'` before `runPipeline` returns
- The TUI retry handler (`src/tui.tsx` around line 2512) successfully finds the failed stage and does not display "No failed stage to retry"
- Both the initial creation path and the resume path apply the same fix
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/pipeline.ts` lines 528–550 — initial workspace setup failure path
- `src/pipeline.ts` lines 600–621 — resume workspace setup failure path
- `src/tui.tsx` line 2511–2518 — retry handler using `pipeline.stages.find(s => s.status === 'failed')`
- The fix is to mark `pipeline.stages[0]` (the `define` stage) as `'failed'` at both failure sites before returning
- The stage array is already populated when setup runs; no structural changes needed, only status mutation
