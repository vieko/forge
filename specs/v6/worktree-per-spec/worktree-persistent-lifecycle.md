---
depends: [worktree-registry-schema.md]
---

# Persistent worktree lifecycle with enforced status transitions

## Outcome

Worktrees persist across multiple forge invocations (run, audit, proof) instead of being auto-cleaned after run completes. A state machine enforces valid status transitions. Each transition updates the worktree registry in the DB. Users explicitly control when worktrees advance through the lifecycle.

## Acceptance Criteria

- Valid status transitions enforced: created->running, running->complete, running->failed, complete->auditing, auditing->audited, auditing->failed, audited->proofing, complete->proofing (skip audit), proofing->proofed, proofing->failed, complete->ready (skip audit+proof), proofed->ready, ready->merging, merging->merged, merging->merge_failed (type-check failure after clean merge, merge reverted), merging->paused (unresolvable git conflict), paused->merging (resume after manual fix), merge_failed->ready (retry consolidation after fixing the worktree), merged->cleaned, failed->created (retry — resets to beginning of lifecycle)
- `transitionWorktreeStatus()` enforces these transitions exactly — `failed` can only go to `created` (full retry), `merge_failed` can only go to `ready` (re-attempt consolidation). This prevents a run-failed worktree from bypassing the lifecycle to reach `ready`
- `transitionWorktreeStatus(id, newStatus)` function validates the transition and throws on invalid ones
- Worktrees are NOT cleaned up after `runSingleSpec` or `runForge` completes -- current `cleanupWorktree()` calls removed from the run path
- `updated_at` timestamp refreshed on every status transition
- `commitWorktree()` still commits changes but does not trigger cleanup
- Status transitions logged to session events for audit trail
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/utils.ts` (createWorktree, commitWorktree, cleanupWorktree), `src/parallel.ts` (runForge worktree cleanup block), `src/db.ts` (worktrees table)
- Current flow in `runForge()`: create worktree -> run specs -> commit -> cleanup. The cleanup step is removed; commit remains
- The lifecycle is user-paced: forge run sets `complete`, user triggers audit which sets `auditing`/`audited`, etc.
- `ready` status signals that the worktree is eligible for consolidation
- `failed` status for pre-consolidation stage failures (run, audit, proof); `merge_failed` for consolidation type-check failures (merge was reverted); `paused` for unresolvable git conflicts during consolidation
- `proofing` is an active state (like `running`, `auditing`) representing proof generation in progress; `proofed` is the completion state
- During consolidation, `merging->merge_failed` means a clean merge broke type-checking and the agent couldn't fix it (merge was reverted); `merging->paused` means a git conflict the agent couldn't resolve (merge is in-progress, awaiting human). These are distinct failure modes with distinct recovery paths: `merge_failed->ready` retries consolidation, `paused->merging` resumes with manual fix
- Allow skip transitions (complete->ready) for specs that don't need audit/proof
- `failed->created` resets the worktree to the beginning of the lifecycle for a full retry (not `failed->running`, since the user may want to re-audit before re-proofing)
- `paused->merging` allows resumption after manual conflict resolution
