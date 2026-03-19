# Forge Execution Best Practices

Forge has two distinct operating modes:

- Authoring mode: `define`, `proof`, docs/spec writing, and read-heavy planning can run against your current checkout.
- Execution mode: `run`, isolate worktrees, consolidation, MCP-triggered runs, and executor-driven work should be treated as committed-state validation.

## MCP and Executor Freshness

If you change Forge runtime code and then use MCP or the executor daemon, make sure the process that actually performs work is running the updated build.

Recommended sequence:

1. Commit the Forge/runtime change that isolate worktrees or MCP-driven runs need to see.
2. Run `bun run build`.
3. Restart the executor daemon or otherwise ensure a stale background process is not serving the old build.
4. Start the MCP workflow or executor-backed run.

Why this matters:

- MCP commands can outlive the shell session where you edited code.
- isolate worktrees are created from git state, not your uncommitted filesystem.
- a stale executor can make a fresh CLI checkout look broken when the problem is actually process drift.

## Isolate Runs

Use `run --isolate` when you want committed-state validation across one or more specs.

Rules of thumb:

- commit prerequisite Forge/runtime fixes before starting isolate work
- treat isolate output as verification of the committed ref, not of unstaged local edits
- rebuild after runtime changes that affect MCP hooks, verification, worktree setup, or execution orchestration

## Consolidation Runs

Consolidation should be treated as a second-stage proof that individually successful worktrees still merge and verify together.

Recommended practice:

- get each worktree to a clean `ready` state first
- keep verification commands objective and repo-local
- prefer spec scopes and package-aware verification in monorepos so failures stay actionable

## Verification Discipline

Forge is strongest when success is determined by external checks instead of narrative agent output.

Prefer:

- build, typecheck, test, lint, and proof commands
- narrow package-scoped verification when the repo supports it
- failing closed on terminal API errors or empty results

Avoid:

- manual "looks good" pass decisions
- relying on executor/MCP state you have not refreshed after runtime edits
- starting isolate validation from an uncommitted local fix you expect worktrees to inherit
