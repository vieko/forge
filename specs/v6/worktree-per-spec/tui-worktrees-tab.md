---
depends: [worktree-registry-schema.md]
---

# TUI worktrees tab for multi-worktree monitoring

## Outcome

`forge tui` has a new Worktrees tab showing all active worktrees with their status, associated spec, branch, path, and progress. The tab updates in real time via DB polling and provides a dashboard view for managing parallel worktree-based development.

## Acceptance Criteria

- Fourth tab added to TUI: Sessions | Specs | Pipeline | Worktrees
- Worktrees listed with columns: status (color-coded), spec name, branch, worktree path, age
- Status color coding: green for complete/audited/proofed/ready/merged, yellow for running/auditing/proofing/merging, red for failed/merge_failed/paused, dim for created/cleaned
- Real-time updates via `useDbPoll()` (existing DB polling hook)
- Navigation: j/k to scroll, enter for detail view showing full worktree info
- Detail view shows: spec content, run history, status transitions, cost
- Worktrees sorted by updated_at descending (most recently active first)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/tui.tsx` (TUI components, TabBar, useDbPoll), `src/db.ts` (worktrees table)
- Follow existing TUI patterns: ink/React components, Box/Text layout, useInput for keybinds
- DB polling via `PRAGMA data_version` already handles live updates; worktrees tab just needs a new query
- Tab keybind cycle (tab key) extended to include the new Worktrees tab
