---
depends: [db-core.md]
---

# Pipeline State in Database

## Outcome

Pipeline, stage, and gate state is stored in forge.db tables via a new `SqliteStateProvider` that implements the existing `StateProvider` interface. The filesystem-based `FileSystemStateProvider` remains available as a fallback. `pipeline.json` in git is updated as a lightweight reference/pointer to the active pipeline.

## Acceptance Criteria

- `pipelines` table with columns: `id`, `goal`, `status`, `branch`, `worktreePath`, `totalCost`, `createdAt`, `updatedAt`, `completedAt`
- `stages` table with columns: `pipelineId`, `name`, `status`, `cost`, `duration`, `sessions` (JSON array), `artifacts` (JSON object), `startedAt`, `completedAt`, `error`
- `gates` table with columns: `pipelineId`, `fromStage`, `toStage`, `type`, `status`, `approvedAt`
- `SqliteStateProvider` implements the existing `StateProvider` interface from `src/pipeline-types.ts`
- `FileSystemStateProvider` remains functional as fallback (graceful degradation)
- `pipeline.json` continues to be written to git as a reference — contains the active pipeline ID and minimal metadata
- Pipeline list queries (`listPipelines`) use SQL `ORDER BY` instead of directory scanning + sort
- TypeScript compiles without errors

## Context

- Relevant files: `src/pipeline-types.ts` (StateProvider interface at line 239, Pipeline/Stage/Gate types), `src/pipeline-state.ts` (FileSystemStateProvider — the implementation being paralleled)
- New file: `src/db-pipeline-state.ts` — SqliteStateProvider implementation
- The `StateProvider` interface is the migration seam — `src/pipeline.ts` (orchestrator) already codes against the interface, not the implementation
- `sessions` column stores JSON array of session IDs (string[]); `artifacts` stores JSON object (Record<string, string>)
- Gate polling in `src/pipeline.ts` (`pollForGateResolution`) currently reads the filesystem — with DB, it reads the gates table row
- The `branch` and `worktreePath` columns are nullable (used by worktree-pipelines.md later)
