# Worktree registry table in SQLite

## Outcome

The SQLite database has a `worktrees` table that tracks every worktree's identity, location, status, and associations. CRUD functions enable all lifecycle operations to go through this registry. This is the single source of truth for worktree state across CLI, MCP, TUI, and executor.

## Acceptance Criteria

- `worktrees` table created with columns: id (TEXT PK), work_group_id (TEXT nullable), spec_path (TEXT), spec_paths (TEXT, JSON array for multi-spec), branch (TEXT), worktree_path (TEXT), status (TEXT), linear_issue_id (TEXT nullable), pid (INTEGER nullable), task_id (TEXT nullable), session_id (TEXT nullable), error (TEXT nullable), created_at (TEXT), updated_at (TEXT)
- Status values constrained to: created, running, complete, failed, auditing, audited, proofing, proofed, ready, paused, merging, merge_failed, merged, cleaned
- CRUD functions exported: `insertWorktree`, `getWorktree`, `getWorktreeByPath`, `updateWorktreeStatus`, `listWorktrees`, `getWorktreesByWorkGroup`, `getWorktreeByBranch`, `linkWorktreeTask`, `linkWorktreeSession`
- Indexes on worktrees.status, worktrees.work_group_id, worktrees.branch, worktrees.task_id
- DB migration increments schema version in `initDb()` migration chain
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/db.ts` (migration chain, initDb), `src/types.ts`
- Follow existing migration pattern from pipelines/stages/gates tables
- The worktrees table is independent of the spec_entries table (no FK between them) but shares work_group_id for grouping
- spec_paths stores a JSON array when multiple specs are assigned to one worktree (single-worktree mode)
- spec_path is the primary spec for single-spec worktrees; spec_paths covers multi-spec
- pid tracks the running process for PID-based stale detection (same pattern as pipelines.pid)
- task_id links to the tasks table for executor-dispatched worktrees; session_id links to the sessions table for SDK session tracking
- error stores failure reason for failed/paused worktrees (conflict details, build errors, etc.)
- `failed` for pre-consolidation failures (run/audit/proof); `merge_failed` for consolidation type-check failures (merge reverted); `paused` for unresolvable git conflicts during consolidation. Three distinct failure states with distinct recovery paths
