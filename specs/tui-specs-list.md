---
depends: [tui-view-switcher.md]
---

# Specs list view showing manifest lifecycle

## Outcome

The Specs tab renders a scrollable list of every entry in the spec manifest, grouped by directory, with per-row status icons, run count, cost, duration, and last-updated timestamp. Keyboard navigation and scroll behaviour mirror the existing Sessions list.

## Acceptance Criteria

- A `SpecsList` component is wired into the Specs tab (replacing the placeholder from `tui-view-switcher.md`)
- The component calls `loadManifest(cwd)` from `src/specs.ts` and re-polls every 5 seconds
- Entries are grouped by their parent directory (e.g. `specs/auth/` as a dimmed group header), sorted alphabetically within each group; ungrouped specs (root-level) appear under a `specs/` header
- Each row displays: status icon (`+` / `x` / `-`) in its status colour, spec filename (truncated), run count, total cost, total duration (sum across all runs), and `formatRelativeTime(entry.updatedAt)`
- Column widths are fixed and consistent; rows are padded / truncated to prevent line bleed (match `SessionRow` padding pattern)
- `up` / `k` and `down` / `j` move the selection; scroll offset auto-adjusts to keep the selected row visible
- An empty state message is shown when the manifest contains no specs
- Pressing `q` quits; pressing `tab` switches back to the Sessions tab (via the App-level handler)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/tui.tsx` — add `SpecsList` component; extend App state with `specsListIndex` / `specsScrollOffset` to preserve cursor on tab switch
- `src/specs.ts` — `loadManifest(cwd): Promise<SpecManifest>` (graceful empty return if file absent)
- `src/types.ts` — `SpecEntry { spec, status, runs: SpecRun[], source, createdAt, updatedAt }`, `SpecRun { costUsd?, durationSeconds, timestamp, status }`
- Helper functions already in `tui.tsx` to reuse: `formatCost`, `formatDuration`, `formatRelativeTime`, `pad`, `padStart`, `truncate`
- Status colour conventions already in `tui.tsx`: green `#22c55e` (passed), red `#ef4444` (failed), yellow/dim `#bbbbbb` (pending)
- Reference `SessionsList` for header-lines / footer-lines scroll-height calculation pattern
- Total cost per spec = `entry.runs.reduce((s, r) => s + (r.costUsd ?? 0), 0)`
- Total duration per spec = `entry.runs.reduce((s, r) => s + r.durationSeconds, 0)`
