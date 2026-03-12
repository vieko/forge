---
---

# Plan Mode as First-Class

## Outcome

The `--plan-only` flag enforces read-only execution at the SDK level by restricting available tools, uses a dedicated planning prompt optimized for architecture analysis, and supports a `--plan-model` option for using a cheaper model during planning. Safety is enforced by construction at the `query()` call, not by prompt instruction alone.

## Acceptance Criteria

- SDK-level tool restrictions for `--plan-only`: Write and Edit disabled via `disallowedTools: ['Write', 'Edit']` at the `query()` call level (not just prompt text)
- Bash remains available for read-only exploration (`ls`, `git log`, `find`, `cat`, etc.) — the planning prompt constrains Bash to read-only commands ("Do not create, modify, or delete files")
- Dedicated planning prompt: instructs read-only exploration, architecture analysis, dependency mapping, and structured plan document output
- `--plan-model <model>` CLI option to use a different model for planning (e.g. `--plan-model sonnet` for plan, default `opus` for execute)
- Plan output saved as a structured document in `.forge/plans/<timestamp>.md`
- Verification step skipped for plan-only runs (existing behavior preserved)
- Lower default budget for plan-only runs (e.g. $5 instead of $50)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/run.ts` (planOnly handling at ~line 159, verification skip at ~line 227), `src/core.ts` (runQuery, QueryConfig), `src/index.ts` (--plan-only CLI option at line 87)
- Current implementation: `planOnly` only modifies the prompt text (`"Do NOT implement - planning only"`) — no SDK-level enforcement
- The Agent SDK `query()` function accepts `disallowedTools: string[]` (confirmed at sdk.d.ts:547) — this removes tools from the model's context entirely
- Write and Edit are blocked by construction; Bash is allowed but prompt-constrained to read-only. This is the right trade-off: blocking Bash entirely would prevent the agent from exploring the codebase (`ls`, `git log`, `find`, `tree`), making planning useless
- The `--plan-model` option is separate from `--model` — plan uses the plan model, subsequent execution uses the main model
- Plan documents should include: goal summary, file inventory, dependency analysis, implementation steps, risk assessment
