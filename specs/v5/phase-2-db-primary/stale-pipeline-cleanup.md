---
depends: [db-primary-pipeline-provider.md]
---

# Stale pipeline detection and cleanup

## Outcome

Pipelines whose process has died or that have been running for over two hours without progress are automatically marked as `failed`. A `pid` column on the pipelines table enables liveness-based staleness detection, matching the existing pattern for tasks.

## Acceptance Criteria

- The `pipelines` table gains a `pid` column via a DB migration
- `runPipeline()` writes the current process PID to the pipeline row at startup
- `markStalePipelines()` is added to `src/db-pipeline-state.ts` with dual strategy: PID liveness check (process dead → mark failed) and TTL (running >2 hours with no stage progress → mark failed)
- `markStalePipelines()` is called from the executor poll loop (same site as `markStaleTasks()`)
- `markStalePipelines()` is also called when the MCP `forge_pipeline` tool reads pipeline state
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/db-pipeline-state.ts` — add `markStalePipelines()` here
- `src/pipeline.ts` — set `pid` on the pipeline row when `runPipeline` starts
- `src/db.ts` — add `pid` column migration to the pipelines table schema
- `src/executor.ts` — call `markStalePipelines()` in the poll loop alongside `markStaleTasks()`
- `src/mcp.ts` — call `markStalePipelines()` before returning pipeline state in `forge_pipeline` reads
- Reference: `markStaleTasks()` pattern for the dual PID + TTL strategy
