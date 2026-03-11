---
depends: [tool-block-expand-toggle.md]
---

# Expanded tool block content rendering

## Outcome

When a tool block is expanded, the full tool input parameters and complete result output are rendered inline beneath the tool header. Users can inspect exactly what was sent to and returned from each tool call without leaving the session detail view.

## Acceptance Criteria

- Expanded tool blocks render the full input object as formatted key-value pairs (one key per line, indented under the tool header), with string values shown directly and non-string values JSON-stringified
- Long input values (e.g. `content` for Write, `old_string`/`new_string` for Edit) are rendered in full — not truncated
- The complete result output is rendered below the input section, preserving newlines from the original output
- A visual separator or label distinguishes the input section from the output section (e.g. a dim `Input:` / `Output:` label)
- The 120-char output preview (collapsed view) is replaced by the full output when expanded — not shown redundantly alongside it
- Input and output sections use subdued colors (dim/gray) to keep the tool header label visually dominant
- Content renders correctly for all tool types captured in events: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch, and any others present in `events.jsonl`
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/tui.tsx` — `GroupedBlockView` tool case (lines ~877-897), `summarizeToolInput` (lines ~180-187), `ToolBlock` interface (lines ~191-195)
- `src/types.ts` — `ToolCallStartEvent.input: Record<string, unknown>`, `ToolCallResultEvent.output: string`
- Tool inputs vary by tool: Bash has `command`+`description`, Read has `file_path`+`offset`+`limit`, Edit has `file_path`+`old_string`+`new_string`, Grep has `pattern`+`path`+`glob`, etc.
- Existing `summarizeToolInput` extracts a single field for the collapsed summary — the expanded view shows all fields
- Result output can be very long (thousands of lines for file reads or command output) — rendered in full within the scrollbox, which handles overflow via scrolling
