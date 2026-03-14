---
depends: [worktree-pipelines.md, config.md, detect-package-manager.md]
---

# Workspace Setup and Teardown Hooks

## Outcome

When a pipeline creates a worktree, project-specific setup commands run automatically to make the workspace ready for development (install dependencies, build). On pipeline completion or cancellation, teardown cleans up the worktree. Hooks are auto-detected from the project type and optionally overridden via configuration.

## Acceptance Criteria

- Setup hook runs after worktree creation: auto-detected commands execute in the new worktree directory
- Auto-detection rules: `package.json` present -> `bun install`, `Cargo.toml` -> `cargo build`, `go.mod` -> `go mod download`
- Teardown hook runs on pipeline completion or cancellation, after any worktree commit but before `git worktree remove`
- Hooks configurable via `.forge/config.json` with `setup` and `teardown` arrays of shell commands (overrides auto-detection)
- Setup failure prevents pipeline from starting — pipeline marked `failed` with clear error message including command output
- Setup/teardown commands have a 5-minute timeout (configurable via `.forge/config.json`) — timeout triggers failure
- Setup/teardown command output captured in pipeline stage logs for debugging
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/utils.ts` (createWorktree, cleanupWorktree), `src/pipeline.ts` (runPipeline), `src/verify.ts` (detectVerification — similar project-type auto-detection pattern)
- `src/verify.ts` already detects Node/Cargo/Go projects for verification commands — the same detection pattern applies here
- New file or extension: `src/workspace.ts` — setup/teardown hook runner with auto-detection
- `.forge/config.json` is a new configuration file — does not exist yet. Only the `setup` and `teardown` fields are defined by this spec
- Commands run via `execAsync()` from `src/utils.ts` with timeout (e.g. 5 minutes for `bun install`)
- Multiple project types can coexist (e.g. monorepo with both package.json and Cargo.toml) — run all matching setup commands
