---
depends: [tui-worktrees-tab.md]
---

# TUI worktree actions and cross-tab filtering

## Outcome

The TUI Worktrees tab supports interactive actions: opening a tmux pane cd'd into a worktree, re-running specs, and marking worktrees as ready. The Sessions and Specs tabs can filter their views by worktree for focused monitoring.

## Acceptance Criteria

- Keybind `o` on selected worktree: splits tmux pane and opens `claude` session cd'd into the worktree path
- Keybind `r` on a complete/failed worktree: spawns detached `forge run --spec <path> -C <worktree_path>` (same pattern as Specs tab)
- Keybind `m` on a complete/audited/proofed worktree: marks as `ready` via `transitionWorktreeStatus()`
- Keybind `m` on a `merge_failed` worktree: marks as `ready` (merge_failed->ready transition, re-queues for consolidation retry)
- Keybind `r` on a `paused` worktree: opens tmux pane for manual conflict resolution (same as `o`), since paused means git conflict awaiting human
- Sessions tab filter: when worktree selected, show only sessions linked to that worktree via `worktrees.session_id` or via `tasks.cwd` join (sessions JOIN tasks ON sessions.id = tasks.sessionId WHERE tasks.cwd = worktree_path)
- Toast feedback for all actions (success/failure messages)
- Guards: `o` only when tmux detected, `r` only on valid statuses, `m` validates transition
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/tui.tsx` (TUI components, useInput, spawn patterns, toast system)
- tmux split pattern: `tmux split-window -h -c <worktree_path> claude` (or similar)
- Follow existing TUI spawn pattern from Specs tab: strip CLAUDECODE/CLAUDE_CODE_ENTRYPOINT env vars, detached spawn, toast feedback
- Session filtering joins through the tasks table (which has cwd) since sessions table has no cwd column: `SELECT s.* FROM sessions s JOIN tasks t ON s.id = t.sessionId WHERE t.cwd = ?`. Alternatively, the worktree's session_id column provides a direct link for the primary session
