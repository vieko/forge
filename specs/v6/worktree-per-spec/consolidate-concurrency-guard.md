---
depends: [consolidate-command.md]
---

# Concurrency guard for forge consolidate

## Outcome

Only one `forge consolidate` invocation can run at a time per work group. A second invocation targeting the same work group is rejected with a clear message. This prevents race conditions where two consolidation processes merge the same worktrees concurrently.

## Acceptance Criteria

- Consolidation records its PID in the DB (new `consolidations` table or a `consolidating_pid` column on a work-group-level record)
- Before starting, `forge consolidate` checks for an active consolidation on the same work group via PID liveness check
- If active consolidation found: exit with error message including the PID and work group ID
- If stale PID found (process dead): clear the record and proceed
- PID record cleared on consolidation completion (success, failure, or cancellation)
- Ctrl-C during consolidation clears the PID record in the shutdown handler
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/consolidate.ts` (consolidation logic), `src/db.ts` (schema), `src/abort.ts` (Ctrl-C shutdown)
- Follow existing PID liveness pattern from `src/db-pipeline-state.ts` (markStalePipelines: process.kill(pid, 0))
- This is a lightweight guard — not a distributed lock. Single-machine, single-user assumption
- The guard is per-work-group, not global: consolidating work group A doesn't block consolidating work group B
