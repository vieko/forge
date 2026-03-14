---
depends: [db-primary-sessions.md]
---

# SqliteStateProvider is the sole pipeline state provider

## Outcome

`FileSystemStateProvider` is deleted. `SqliteStateProvider` is the only implementation of the `StateProvider` interface. The pipeline orchestrator, executor, MCP tools, and TUI all use the same provider, eliminating state divergence.

## Acceptance Criteria

- `src/pipeline-state.ts` (`FileSystemStateProvider`) is deleted
- `src/pipeline.ts` uses `SqliteStateProvider` exclusively
- `src/executor.ts` passes `SqliteStateProvider` to `runPipeline`
- `src/mcp.ts` pipeline tools use `SqliteStateProvider`
- `src/tui.tsx` already uses `SqliteStateProvider`; verify no remaining references to `FileSystemStateProvider`
- The `StateProvider` interface in `src/pipeline-types.ts` is preserved as the abstraction boundary
- No regressions in pipeline execution, TUI pipeline tab, or MCP pipeline tools
- Historical pipeline JSON files in `.forge/pipelines/` may be left as inert artifacts
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/pipeline-state.ts` — `FileSystemStateProvider` class (exported, line 181) to be removed
- `src/db-pipeline-state.ts` — `SqliteStateProvider` (line 166) becomes the sole provider
- `src/pipeline-types.ts` — keep `StateProvider` interface; only the implementation changes
- `src/pipeline.ts`, `src/executor.ts`, `src/mcp.ts` — update to use `SqliteStateProvider`
