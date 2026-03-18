---
---

# Define and wire the complete MCP-to-executor option contract

## Outcome

The MCP `forge_start` tool and executor `dispatchTask()` support a defined, documented set of ForgeOptions. Options that are intentionally excluded (e.g., `verbose` — executor is always quiet) are documented as such. No supported queued option is silently dropped between `forge_start` insertion and executor dispatch. Scope is limited to `forge_start` — `forge_pipeline_start` and future queued tools are out of scope.

## Acceptance Criteria

- A comment block or constant in `src/executor.ts` documents the full set of supported queued options and which are intentionally excluded (with reason)
- `dispatchTask()` in `src/executor.ts` extracts all supported options from `extraArgs` and/or typed task `params`, including: `planOnly`, `planModel`, `dryRun`, `maxTurns`, `maxBudgetUsd`, `force`, `sequential`, `sequentialFirst`, `concurrency`, `rerunFailed`, `pendingOnly`, `branch`
- These options are forwarded to `runSingleSpec()`, `runForge()`, `runAudit()`, `runDefine()`, `runProof()`, and `runVerify()` as appropriate per command
- The MCP `forge_start` schema in `src/mcp.ts` accepts optional `max_turns` (number), `max_budget` (number), and `plan_only` (boolean) parameters in addition to the existing `model`, `extra_args`, `spec_path`, `output_dir`
- New MCP parameters are stored in task `params` JSON at insertion time
- Intentionally excluded options: `verbose` (executor is always quiet), `resume`/`fork` (session management doesn't apply to queued tasks), `_onSpecResult` (internal callback)
- A task queued via `forge_start` with `max_turns: 50` actually runs with a 50-turn limit
- A task queued via `forge_start` with `extra_args: ["--plan-only", "--plan-model", "sonnet"]` runs in plan-only mode with the sonnet model
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/executor.ts` lines 159–317 — `dispatchTask()` where most options are currently lost
- `src/mcp.ts` lines 339–425 — `forge_start` schema definition and task insertion
- `src/types.ts` — `ForgeOptions` interface defining the full option surface
- `src/run.ts` — `runSingleSpec()` already accepts all options; wiring is the missing piece
- `src/parallel.ts` — `runForge()` similarly already accepts all options
- The current `extra_args` string array is the escape hatch for CLI flags, but typed params should be preferred for commonly used options to avoid fragile string parsing
