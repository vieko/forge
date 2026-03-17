---
depends: [sibling-worktree-creation.md, worktree-persistent-lifecycle.md]
---

# Single worktree execution mode (default)

## Outcome

The default `forge run --spec-dir` creates one worktree and runs all specs inside it. This is the current behavior enhanced with worktree registry integration and persistent lifecycle. The worktree survives after run completes for subsequent audit, proof, and review.

## Acceptance Criteria

- `forge run --spec-dir specs/eng-123/` creates a single sibling worktree registered in the DB
- All specs execute within that one worktree (sequential or parallel as before)
- Worktree registered with all spec paths in `spec_paths` JSON array
- Results persist to the original repo via `persistDir` (existing behavior preserved)
- Worktree transitions: created -> running -> complete (not cleaned up)
- Batch summary includes the worktree path for user reference
- `forge run --spec <single-file>` also creates a worktree (one spec, one worktree)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/parallel.ts` (runForge, runForgeInner), `src/run.ts` (runSingleSpec), `src/utils.ts` (createWorktree)
- Current `--branch` flag creates a worktree in /tmp/; this replaces it with sibling directory and registry integration
- The `--branch` flag becomes optional: if omitted, a branch name is auto-generated from spec-dir name
- `persistDir` routing already exists for worktree mode -- this spec ensures it works with the new sibling directory pattern
