---
depends: [spec-entries-schema.md, worktree-registry-schema.md]
---

# Work group ID for associating specs, worktrees, and runs

## Outcome

A work group ID is minted at `forge define` time and propagated to all spec entries, worktrees, and runs created from that define session. `forge consolidate` and other commands use the work group ID to discover related worktrees without user enumeration. The ID is a stable, human-readable identifier.

## Acceptance Criteria

- Work group ID generated in `runDefine()` with format: `wg-{timestamp}-{random}` (e.g., `wg-1710500000-a3f2`)
- Work group ID stored in define result metadata (`ForgeResult.workGroupId`)
- Spec entries created by define include the work_group_id in the `spec_entries` table
- `getWorktreesByWorkGroup(workGroupId)` returns all worktrees for a work group
- `listSpecEntriesByWorkGroup(workGroupId)` returns all spec entries for a work group
- `forge define` output displays the work group ID
- When `forge run --isolate` or `forge run --spec-dir` is called without a work_group_id context, a new work group ID is auto-minted at run time and assigned to all worktrees created in that batch
- `forge run --work-group <id>` allows explicitly joining an existing work group (for incremental runs against a previous define)
- Legacy/manual specs that were not created by `forge define` receive an auto-minted work group when first used with `--isolate` or worktree creation
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/define.ts` (runDefine, spec registration), `src/types.ts` (ForgeResult), `src/db.ts` (spec_entries table), `src/specs.ts` (findOrCreateEntry)
- The work group ID bridges the gap between define-time and run-time: specs generated together are grouped together
- Work group ID is optional on spec entries (legacy specs and manually created specs won't have one initially)
- Format should be short enough to use in directory names and branch names
- Auto-minting at run time ensures every worktree-based execution has a work group, regardless of whether `forge define` was used. This covers the case where a user runs preexisting specs without defining them first
- `forge consolidate` requires a work group ID (auto-detected or explicit) — it will never operate on ungrouped worktrees
