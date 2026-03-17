---
depends: [consolidate-command.md, monorepo-worktree-support.md]
---

# Package-scoped incremental type-check during consolidation

## Outcome

When consolidating worktrees in a monorepo, the incremental type-check after each merge runs at the affected package scope first (faster, more targeted feedback), then at the repo root if a root-level tsconfig exists. This gives the SDK fix agent precise, package-scoped errors instead of full-monorepo noise.

## Acceptance Criteria

- `runIncrementalTypeCheck()` in `src/consolidate.ts` accepts an optional `scope` parameter (package directory relative to repo root)
- When `scope` is provided and the scoped directory has a tsconfig (e.g., `packages/api/tsconfig.json`), type-check runs there first via `tsc --noEmit` with cwd set to the scoped directory
- If scoped type-check fails, return the scoped errors immediately (no need to check root -- the errors are already actionable)
- If scoped type-check passes and a root-level `tsconfig.json` exists, run `tsc --noEmit` at repo root as a second pass (catches cross-package type issues introduced by the merge)
- If no scope provided, behavior unchanged: run `detectVerification()` at worktree root (current behavior preserved)
- Scope derived from the worktree's spec frontmatter `scope:` field, read during `mergeWorktreeBranch()` and passed through to type-check
- `fixTypeErrors()` prompt includes the scope context so the agent knows which package to focus on
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/consolidate.ts` (runIncrementalTypeCheck lines 148-177, mergeWorktreeBranch, fixTypeErrors lines 185-229), `src/deps.ts` (parseScope for reading frontmatter scope), `src/verify.ts` (detectVerification, monorepo scoping)
- Current `runIncrementalTypeCheck()` runs `detectVerification(workingDir)` at the consolidation worktree root and looks for `tsc --noEmit` -- this works for single-package repos but produces noisy full-monorepo errors in monorepos
- The spec frontmatter `scope: packages/api` is already parsed by `parseScope()` in `src/deps.ts` (lines 128-138) and used by `src/run.ts` for verification scoping -- this extends the same pattern to consolidation
- Scoped type-check is an optimization: root-only type-check is correct but slower and noisier in monorepos
- When multiple worktrees target different packages, each merge's type-check scopes to its own package, keeping error context focused
