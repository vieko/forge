---
depends: [worktree-persistent-lifecycle.md]
---

# Worktree-scoped proof generation

## Outcome

`forge proof` accepts a `--worktree <id>` flag to scope proof generation to changes introduced by that worktree's spec only. Test protocols are tightly scoped to the diff between the worktree branch and main, not the full codebase. The worktree status advances to `proofed` on completion.

## Acceptance Criteria

- `forge proof --worktree <id>` resolves the worktree from the registry
- Proof prompt includes the git diff between the worktree branch and main to scope test generation
- Generated test files are colocated with source in the worktree (following detected test convention)
- Proof manifest written to the worktree or main repo's `.forge/proofs/` directory
- Worktree status transitions to `proofing` on start, then `proofed` on success or `failed` on failure (with error in `error` column)
- Pre-consolidation proof tests only verify the spec's changes, not full integration
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/proof.ts` (runProof, detectTestConvention), `src/db.ts` (worktrees table), `src/utils.ts` (persistDir)
- Current proof reads all specs and generates comprehensive tests; worktree-scoped proof narrows the focus using `git diff main...{branch}`
- The diff-based scoping ensures proof tests are proportional to the changes made, not the full spec surface
- Proof output location should be configurable: worktree-local or centralized in main repo
