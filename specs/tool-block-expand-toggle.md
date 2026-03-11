---
depends: [tool-block-focus.md]
---

# Tool block expand/collapse toggle

## Outcome

Each tool block in the session detail view can be toggled between collapsed (default) and expanded states. The user presses `Enter` on the focused tool block to expand or collapse it. A visual indicator on each tool block communicates whether it is collapsed or expanded. The footer keybindings hint is updated to show the new interaction.

## Acceptance Criteria

- `SessionDetail` maintains a `Set<number>` (or equivalent) of expanded block indices
- Pressing `Enter` (or `return`) toggles the focused tool block between expanded and collapsed
- Each tool block displays a collapse/expand indicator: `+` when collapsed, `-` when expanded (prepended to the `[ToolName]` label or placed at the left edge)
- `GroupedBlockView` accepts an `isExpanded` boolean prop; the tool case reads it to decide which indicator to show
- Collapsed state shows the existing summary (tool name, input summary, 120-char output preview) — no visual regression from current behavior
- The footer hint line includes `[enter] expand` (or `collapse` contextually) alongside existing hints
- Expanding a block does not break sticky scroll behavior for live sessions
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/tui.tsx` — `SessionDetail` component, `GroupedBlockView` component, `useKeyboard` handler, footer hint (line ~1046)
- Depends on `tool-block-focus.md` for `focusedToolIndex` — `Enter` acts on the currently focused tool block
- The expanded Set is keyed by block index within `groupedBlocks`; indices may shift as new events arrive — consider keying by `toolUseId` from `start.toolUseId` for stability, falling back to block index
