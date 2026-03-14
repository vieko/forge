---
depends: [workspace-hooks.md, worktree-pipelines.md]
---

# Re-run Workspace Setup Hooks on Worktree Recreation During Resume

## Outcome

When a pipeline is resumed and its worktree no longer exists (e.g., after a prior failure or cancellation), the worktree is recreated and workspace setup hooks run automatically — just as they do on initial pipeline creation. The resumed pipeline operates in a fully initialized workspace with dependencies installed and build artifacts present.

## Acceptance Criteria

- When `runPipeline` resumes a pipeline whose worktree was cleaned up, workspace setup hooks execute in the recreated worktree before any stage runs
- The same setup resolution logic applies: config overrides take precedence, otherwise auto-detection runs (`bun install`, `cargo build`, `go mod download`)
- Setup failure on resume marks the pipeline as `failed` with a clear error message including command output, and the recreated worktree is cleaned up
- Setup timeout on resume uses the configured `setupTimeout` value (default 5 minutes)
- A pipeline event is published on setup failure during resume (consistent with the initial creation path)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/pipeline.ts` lines 557-587: the resume path recreates the worktree via `createWorktree` but does not call `resolveSetupCommands` or `runWorkspaceHooks` — contrast with the new-pipeline path at lines 512-556 which does run setup hooks
- The fix is localized: after the worktree is successfully recreated on resume (line 565-569), run the same setup hook sequence used during initial creation
- On setup failure during resume, follow the same pattern as the initial creation path: mark pipeline `failed`, publish `pipeline_failed` event, best-effort `cleanupWorktree`, return pipeline
