---
---

# Structured JSONL event log for forge sessions

## Outcome

`runQuery()` in `src/core.ts` writes a structured JSONL event log to `.forge/sessions/{sessionId}/events.jsonl` alongside the existing `stream.log`. Each line is a typed JSON event capturing thinking blocks, text deltas, tool call inputs, tool call results, and session metadata. The existing `stream.log` continues to be written unchanged for backwards compatibility with `forge watch`.

## Acceptance Criteria

- A `.forge/sessions/{sessionId}/events.jsonl` file is created at session start and written during `runQuery()` execution
- `session_start` event is written first with fields: `type`, `timestamp`, `sessionId`, `model`, `specPath`, `prompt`
- `thinking_delta` events capture extended thinking block content from the `thinking_delta` stream event (currently missing from stream.log)
- `tool_call_start` events capture tool name and full input object (complement to existing audit.jsonl which only captures inputs)
- `tool_call_result` events capture tool output from the `PostToolUse` hook (currently no output is logged anywhere)
- `session_end` event is written on completion with fields: `type`, `timestamp`, `numTurns`, `costUsd`, `durationSeconds`, `status`
- `stream.log` continues to be written exactly as before — no changes to its format or content
- TypeScript compiles without errors and existing tests still pass

## Context

- `src/core.ts` — `runQuery()` is the sole entry point; handles stream events via SDK hooks and streaming callbacks. Text buffering happens at `content_block_stop`. Tool names/inputs already derived via `deriveActivity()` for stream.log. Add parallel JSONL writes here.
- `src/types.ts` — Add `SessionEvent` discriminated union type (one variant per event type: `session_start`, `text_delta`, `thinking_delta`, `tool_call_start`, `tool_call_result`, `session_end`). All variants share `type: string` and `timestamp: string`.
- `src/watch.ts` — Reads `stream.log` via `fs.watch()` + polling; must be left untouched
- `src/mcp.ts` — `forge_watch` tool reads `stream.log` via `latest-session.json`; must remain working
- `.forge/sessions/{sessionId}/` — Directory already created for `stream.log`; `events.jsonl` goes in the same directory
- Write pattern: fire-and-forget (same as stream.log) — use `.catch(() => {})` to never block the agent
- `thinking_delta` stream events come from the SDK's extended thinking feature; only emitted when model is configured for thinking. Guard with existence check before accessing `.thinking`.
- `tool_call_result` output: the `PostToolUse` hook receives `{ tool, input, output }` — `output` is the string result to log
