---
depends: [worktree-registry-schema.md]
---

# Worktree-scoped watch command

## Outcome

`forge watch` accepts a `--worktree <id>` flag to follow only sessions associated with that worktree. When scoped, the auto-follow logic stays within the worktree's sessions instead of jumping to the global latest session. Without the flag, existing behavior is preserved.

## Acceptance Criteria

- `forge watch --worktree <id>` filters sessions to those associated with the worktree
- Session-to-worktree association resolved via two paths: (1) `worktrees.session_id` direct link for the primary session, (2) `sessions JOIN tasks ON sessions.id = tasks.sessionId WHERE tasks.cwd = worktree.worktree_path` for all sessions run in that worktree
- Auto-follow logic only advances to the next session within the same worktree (polls DB for new sessions matching the worktree, not `latest-session.json`)
- Spec divider headers in watch output include the worktree identifier
- Falls back to global `latest-session.json` behavior when no `--worktree` flag provided
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/watch.ts` (runWatch, session following logic), `src/db.ts` (worktrees table, sessions table), `src/index.ts` (CLI flag parsing)
- Current watch resolves initial session from `latest-session.json` and auto-follows by polling that file; worktree-scoped mode replaces this with DB-based session discovery
- The sessions table has no `cwd` column (src/db.ts:139). The association goes through either `worktrees.session_id` (direct link set by executor/run) or through the tasks table (which has `cwd`). Both paths are established by worktree-registry-schema.md and executor-worktree-creation.md
- When scoped, watch queries the DB for sessions ordered by `startedAt` within the worktree, then tails each session's `events.jsonl` in sequence
