---
---

# Shared Persistence Routing

## Outcome

All forge commands that persist state (define, audit, proof, verify) accept and route through a `persistDir` parameter, writing `.forge/` artifacts to a specified directory instead of the working directory. This is the prerequisite for worktree-based pipelines where code lives in a worktree but state routes back to the original repo.

## Acceptance Criteria

- `runDefine` accepts `persistDir` option and writes results to `persistDir/.forge/` instead of `workingDir/.forge/` when set
- `runAudit` and `runAuditRound` accept `persistDir` option and write audit results/remediation specs to `persistDir/.forge/` when set
- `runProof` accepts `persistDir` option and writes proof manifests/test protocols to `persistDir/.forge/` when set
- `runVerify` accepts `persistDir` option and writes verify results to `persistDir/.forge/` when set
- `saveResult()` in `src/utils.ts` accepts `persistDir` and routes to it when set (currently always uses `workingDir`)
- Pipeline orchestrator (`src/pipeline.ts`) passes `persistDir` to all stage execution functions, not just `runSingleSpec`
- Existing behavior unchanged when `persistDir` is not set (defaults to `workingDir`)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files:
  - `src/core.ts` (QueryConfig.persistDir at line 30, used at line 99) — already supports persistDir for session logs
  - `src/run.ts` (line 207) — only place that currently passes persistDir to runQuery
  - `src/define.ts` (line 154) — `saveResult(workingDir, ...)` hardcoded
  - `src/audit.ts` (line 210, 453) — `saveResult(workingDir, ...)` and results path hardcoded
  - `src/proof.ts` (line 342, 424) — proof dir and `saveResult(workingDir, ...)` hardcoded
  - `src/proof-runner.ts` (line 366) — `saveResult(workingDir, ...)` hardcoded
  - `src/pipeline.ts` (line 181+) — passes only `cwd` to stage commands
- The `persistDir` pattern is proven in `runQuery` (core.ts:99) — this spec extends it to all commands that write to `.forge/`
- Each command needs its function signature extended with an optional `persistDir?: string` parameter
- The pipeline orchestrator is the primary consumer — it will set `persistDir` to the original repo when executing stages in a worktree
