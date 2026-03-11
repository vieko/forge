# Tool block focus tracking in session detail

## Outcome

The TUI session detail view tracks which tool block is currently focused as the user navigates with `n`/`N`. The focused tool block is visually highlighted so the user always knows which tool call they are inspecting. Focus state is the foundation for expand/collapse interaction.

## Acceptance Criteria

- `SessionDetail` maintains a `focusedToolIndex` state (index into `toolBlockIndices`) that updates when `n`/`N` is pressed
- `n` advances `focusedToolIndex` forward (wrapping or clamping at end); `N` moves it backward
- The focused tool block renders with a distinct left-edge highlight (e.g. a colored `>` prefix or a contrasting `fg`/`bg` on the `[ToolName]` label) so it stands out from unfocused tool blocks
- `GroupedBlockView` accepts an `isFocused` boolean prop; the tool case uses it to conditionally apply the highlight style
- Focus resets (or clamps) when the grouped blocks list changes (e.g. new events arrive in a live session)
- When the user scrolls manually with `j`/`k`/`g`/`G`, `focusedToolIndex` is **not** cleared — it persists until the next `n`/`N` press
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/tui.tsx` — `SessionDetail` component (lines ~902-1051), `GroupedBlockView` (lines ~831-900), `toolBlockIndices` memo (lines ~917-923), `n`/`N` key handler (lines ~962-992)
- Current `n`/`N` navigation scrolls to the next tool block by position but does not track a focus index — it scans children relative to scroll offset
- The `n`/`N` handler already iterates `toolBlockIndices` and calls `scroll.scrollBy(relY)` — the change adds index tracking on top of the existing scroll behavior
- ASCII-only indicators (no emoji/unicode) per project convention
