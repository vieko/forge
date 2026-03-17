---
depends: [worktree-persistent-lifecycle.md]
---

# Workspace hooks for worktree-per-spec execution

## Outcome

Workspace setup/teardown hooks (currently coupled to pipeline.ts) are extracted into a reusable module that worktree-per-spec execution can invoke. When a worktree is created for a spec, setup hooks run automatically (lockfile install, cargo build, go mod download). When a worktree is cleaned up, teardown hooks run first.

## Acceptance Criteria

- Extract `resolveSetupCommands()`, `resolveTeardownCommands()`, and `runWorkspaceHooks()` from pipeline-specific code into a shared module (e.g., `src/workspace.ts` or extend existing workspace utilities)
- `createWorktree()` accepts an optional `runSetup: boolean` flag; when true, runs setup hooks after worktree creation
- Setup hooks auto-detect package manager (bun/pnpm/npm/yarn), Cargo, Go — same detection as pipeline.ts
- Config overrides via `.forge/config.json` setup/teardown arrays (same as pipeline)
- Setup failure marks worktree status as `failed` with error message in the `error` column
- `cleanupWorktree()` runs teardown hooks before removing the worktree directory
- Setup timeout configurable (default 120s, same as pipeline)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/pipeline.ts` (lines 504-562 setup, 957-993 teardown), `src/utils.ts` (createWorktree, cleanupWorktree), `src/config.ts` (.forge/config.json)
- Pipeline.ts currently inlines setup/teardown logic; this spec extracts it so both pipeline and worktree-per-spec can use it
- The executor's `dispatchTask()` calls setup after worktree creation; direct CLI worktree creation also calls setup
- Teardown is best-effort (doesn't throw on failure), same as current pipeline behavior
