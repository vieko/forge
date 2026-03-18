---
depends: [tui-worktrees-tab.md]
---

# TUI worktree detail view: run history, cost, and spec content

## Outcome

The TUI WorktreeDetail component displays the same rich information as the CLI `forge worktree status <id>` command: spec content preview, run history with cost and duration, and aggregated totals. Users can assess worktree health without leaving the TUI.

## Acceptance Criteria

- WorktreeDetail renders a "Run History" section showing each spec run: timestamp, status, cost (USD), duration, and turns
- Run history loaded via `getSpecRunsByEntry()` joined through `getSpecEntryByPath(worktree.spec_path)` (same pattern as `showWorktreeStatus()` in `src/worktree-cli.ts` lines 240-267)
- Aggregated totals displayed below run history: total cost, total duration
- WorktreeDetail renders a "Spec Content" section showing the first 20 lines of the spec file (dimmed, read via `fs.readFile` at `worktree.spec_path` resolved against cwd)
- Graceful degradation: if spec file is unreadable or spec entry is missing, section is omitted (not an error)
- Both sections refresh on `dbVersion` change (existing live-refresh pattern)
- Layout fits within terminal constraints: run history rows are compact (one line each), spec content is scrollable or truncated
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/tui.tsx` (WorktreeDetail component, lines 2358-2534), `src/worktree-cli.ts` (showWorktreeStatus lines 240-292 as reference implementation), `src/db.ts` (getSpecEntryByPath, getSpecRunsByEntry)
- The CLI already implements this exact data retrieval pattern in `showWorktreeStatus()` -- the TUI version mirrors it in React/ink components
- The current TUI WorktreeDetail shows metadata (status, branch, path, timestamps, IDs, error, spec files list) but not run history, cost, or spec content
- Keep the existing metadata section; add run history and spec content below it
- Follow existing TUI text styling: `#888888` for labels, `#bbbbbb` for values, `#22c55e` for pass, `#ef4444` for fail
