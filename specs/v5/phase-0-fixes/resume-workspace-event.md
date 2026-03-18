---
---

# Resume path publishes workspace_setup event

## Outcome

The pipeline event log is consistent regardless of whether a pipeline ran fresh or was resumed after worktree cleanup. Both paths publish a `workspace_setup` event with setup output after successful workspace initialization.

## Acceptance Criteria

- After successful resume-path workspace setup, a `workspace_setup` event is published to the event log
- The event payload uses the same truncation logic as the initial path (10 KB max)
- A freshly run pipeline and a resumed pipeline produce equivalent `workspace_setup` events in their event histories
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/pipeline.ts` lines 557–565 — initial path publishes `workspace_setup` event with truncated output
- `src/pipeline.ts` lines 584–627 — resume path runs the same hooks but does not publish an event
- The fix is to add event publishing after line 625 in the resume path, matching the shape and truncation of the initial path
- Use the same 10 KB truncation constant already defined in the initial path
