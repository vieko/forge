---
depends: [structured-event-log.md]
---

# forge_watch MCP tool returns structured events from events.jsonl

## Outcome

The `forge_watch` tool in `src/mcp.ts` reads from `events.jsonl` when available and returns typed structured events — reasoning text, thinking blocks, tool calls with inputs, and tool results — instead of raw colorized log lines. Claude Code gets richer visibility into running sessions with no extra tooling. When `events.jsonl` does not exist, the tool falls back to returning stream.log lines as before.

## Acceptance Criteria

- `forge_watch` checks for `events.jsonl` in the same directory as `stream.log` (derived from `latest-session.json`)
- When `events.jsonl` exists, the tool returns an array of structured event objects with at minimum: `type`, `timestamp`, and type-specific fields (`content`, `tool`, `input`, `output`, `thinking`)
- `thinking_delta` events are included in the response so Claude Code can see agent reasoning
- `tool_call_result` events are included so tool outputs are visible (currently only tool names appear in stream.log)
- When `events.jsonl` does not exist (e.g. old session, or structured-event-log not yet in place), the tool returns the existing `lines` array from stream.log unchanged
- The response schema includes a `format` field: `"structured"` when reading events.jsonl, `"legacy"` when falling back to stream.log
- Existing `forge_watch` callers that only inspect `lines` continue to work — `lines` field is still populated in legacy mode
- TypeScript compiles without errors and existing MCP tests still pass

## Context

- `src/mcp.ts` — `forge_watch` tool handler (~line 200+); currently reads `latest-session.json` → `logPath` → `stream.log` last N lines. Extend to also check `logPath.replace('stream.log', 'events.jsonl')`.
- `src/types.ts` — `SessionEvent` discriminated union (from structured-event-log spec) is the type for parsed events.jsonl lines.
- `.forge/sessions/{sessionId}/events.jsonl` — Line-delimited JSON; each line is a `SessionEvent`. Read with `fs.readFileSync` and split on newline, same pattern as stream.log.
- `lines` parameter on `forge_watch` tool controls how many recent events to return; apply the same limit to events.jsonl (last N events by line count).
- MCP response shape change is additive: add `format: "structured" | "legacy"` and `events: SessionEvent[]` fields alongside existing `lines: string[]`. Do not remove `lines`.
- `src/mcp.test.ts` — Protocol-level tests via stdio client; add tests for structured response when events.jsonl exists and legacy fallback when it does not.
