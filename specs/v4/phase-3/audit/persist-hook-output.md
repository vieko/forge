---
depends: [workspace-hooks.md]
---

# Persist Workspace Hook Output to Pipeline Logs

## Outcome

Setup and teardown command output is captured in pipeline event logs regardless of success or failure, making workspace initialization debuggable without requiring stdout access. When `bun install` runs during pipeline setup, its output is available in the pipeline's event history for later inspection.

## Acceptance Criteria

- On successful setup, a pipeline event is published containing the combined command output (type: `workspace_setup`, with `output` field)
- On successful teardown, a pipeline event is published containing the combined command output (type: `workspace_teardown`, with `output` field)
- Existing failure paths continue to include output in the error message (no regression)
- The new event types are added to the `PipelineEvent` discriminated union in `pipeline-types.ts`
- Output is truncated to a reasonable limit (e.g., 10KB) to prevent oversized event payloads from verbose install commands
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/pipeline.ts` lines 517-555: on setup success, `setupResult.output` is available but discarded — only "Workspace setup complete" is printed to stdout
- `src/pipeline.ts` lines 893-915: on teardown success, `teardownResult.output` is available but discarded — only a warning is printed on failure
- The spec for workspace-hooks.md requires "Setup/teardown command output captured in pipeline stage logs for debugging" — the current implementation only captures output on failure
- The fix adds `events.publish(...)` calls after successful setup/teardown, using the already-available `setupResult.output` and `teardownResult.output` values
- New event types (`workspace_setup`, `workspace_teardown`) need to be added to `PipelineEvent` union and the `PipelineEventBase`-extending interfaces in `pipeline-types.ts`
