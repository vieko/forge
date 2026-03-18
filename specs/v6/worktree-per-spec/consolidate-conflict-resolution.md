---
depends: [consolidate-command.md]
---

# SDK agent conflict resolution during consolidation

## Outcome

When a git merge conflict occurs during consolidation, an Agent SDK query is dispatched to resolve the conflict automatically. The agent receives the conflict diff, the original spec, and both sides of the conflict. After resolution, a type-check verifies correctness. If the agent cannot resolve confidently, consolidation pauses for human review.

## Acceptance Criteria

- Merge conflicts detected via `git merge --no-ff` exit code and `git diff --name-only --diff-filter=U`
- SDK agent invoked with conflict context: conflicted files, spec content, diff from both branches
- Agent resolves conflicts by editing the conflicted files and staging the resolution
- Post-resolution type-check (`tsc --noEmit`) verifies the resolution compiles
- If type-check fails after agent resolution, up to 2 retry attempts with error feedback
- If agent cannot resolve (max retries exceeded), worktree status transitions to `paused` (via merging->paused transition) with conflicted file list stored in `error` column
- Consolidation skips the paused worktree AND all worktrees that transitively depend on it (using the dependency graph from `topoSort()`). Skipped dependents remain in `ready` status (not paused) with a log message explaining why they were skipped
- `git merge --abort` reverts the failed merge on the consolidation branch before continuing with non-dependent worktrees
- Conflict resolution attempts logged to session events for audit trail
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/consolidate.ts` (consolidation logic), `src/core.ts` (runQuery for SDK agent), `src/verify.ts` (runVerification)
- The agent receives a focused prompt: resolve these specific conflicts, preserve both sides' intent, ensure compilation
- This is interactive only as a last resort: the agent handles most conflicts automatically
- Cost tracking: conflict resolution SDK calls are attributed to the consolidation session
- The dependency graph is loaded from spec frontmatter via `topoSort()` in `src/deps.ts` — same graph used for execution ordering is reused for skip propagation
- Consolidation summary reports: merged count, paused count, skipped-due-to-dependency count, with details on which worktree blocked which dependents
