# Tab bar with Sessions / Specs view switcher

## Outcome

The TUI gains a tab bar at the top that lets the user toggle between a "Sessions" view and a "Specs" view using the `tab` key. The App component tracks which top-level tab is active. The existing Sessions behaviour (list → detail drill-down) is fully preserved.

## Acceptance Criteria

- A tab bar renders as the first line of the UI showing `[ Sessions ]` and `[ Specs ]` labels, with the active tab visually distinguished (e.g. highlighted background or underline colour)
- Pressing `tab` cycles between Sessions and Specs; the tab bar updates immediately
- App state is extended to track the active top-level tab (`'sessions' | 'specs'` or equivalent) independently of the existing `view` sub-navigation state
- When Specs is the active tab a placeholder component is rendered (empty state with a short message); the full specs list is wired in by a subsequent spec
- Switching tabs from Specs back to Sessions restores the previously selected session and list scroll position
- The `q` quit shortcut works from both tabs
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/tui.tsx` — the only file that needs changing; contains `App`, `SessionsList`, `SessionDetail`, all helper functions, and the `useKeyboard` bindings
- `src/types.ts` — read for `SpecEntry` / `SpecManifest` shape awareness (no changes required yet)
- `@opentui/react` primitives available: `box`, `text`, `span`, `scrollbox`, `useKeyboard`, `useTerminalDimensions`
- Current `view` state is `'list' | 'detail'`; the tab switcher adds a second orthogonal dimension — keep session sub-navigation intact rather than merging into a flat enum
- Tab bar should consume exactly one line; remaining height passes through to the active view unchanged
- Colour conventions: active tab `#36b5f0` (blue), inactive `#bbbbbb` (dim), background `#1e293b` (existing dark slate)
