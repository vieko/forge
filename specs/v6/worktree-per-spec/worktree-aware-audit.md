---
depends: [worktree-persistent-lifecycle.md]
---

# Worktree-aware audit command

## Outcome

`forge audit` accepts a `--worktree <id>` flag to scope the audit to a specific worktree. The audit reads code from the worktree path, writes results to the main DB via `persistDir`, and transitions the worktree status through the auditing lifecycle. Audit-fix loops operate entirely within the worktree.

## Acceptance Criteria

- `forge audit --worktree <id>` resolves the worktree path from the registry and runs audit in that context
- Worktree status transitions to `auditing` at audit start
- Worktree status transitions to `audited` on audit completion (clean or with remediation specs)
- Remediation specs from audit-fix loop (`--fix`) are created inside the worktree
- Results persist to the main repo DB (not the worktree's local .forge/)
- `persistDir` set to original repo when auditing inside a worktree
- Audit-fix loop's `runForge()` calls execute within the worktree (no new worktree creation)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/audit.ts` (runAudit, runAuditRound, runAuditFixLoop), `src/db.ts` (worktrees table), `src/utils.ts` (persistDir routing)
- Current audit already supports `persistBase` parameter for worktree routing; this extends it with explicit worktree ID resolution
- The `--worktree` flag is resolved to a worktree_path via DB lookup before audit begins
- Audit reads the codebase state in the worktree (post-run changes), not main
