---
depends: [structured-event-log.md]
---

# forge tui — interactive sessions viewer

## Outcome

A new `forge tui` command launches an interactive terminal UI using `@opentui/react`. The default view is a scrollable sessions list showing running and recent sessions with status, cost, duration, and spec name. Pressing Enter drills into a session to show its live structured event log — agent reasoning and tool calls interleaved — with live updates when the session is still running.

## Acceptance Criteria

- `forge tui` is registered as a CLI command in `src/index.ts` and implemented in `src/tui.ts` (or `src/tui/` directory)
- Sessions list view populates from `.forge/results/*/summary.json` (recent) and `.forge/latest-session.json` (running), sorted by recency
- Each session row displays: status icon (`>` running, `+` passed, `x` failed), spec name, model, cost, duration
- Arrow keys navigate the list; `q` quits; Enter drills into the selected session
- Drill-in view reads `events.jsonl` for the selected session and renders `text_delta` events as agent reasoning and `tool_call_start`/`tool_call_result` events as tool activity blocks
- Running sessions in drill-in view poll `events.jsonl` for new events and re-render live (refresh interval ≤ 500ms)
- `@opentui/core` and `@opentui/react` are added as dependencies in `package.json`
- TypeScript compiles without errors and existing tests still pass

## Context

- `src/index.ts` — All commands registered here via `commander`; add `tui` subcommand with no required args. Follow existing command pattern (banner, `-C` flag for cwd, `-v`/`-q` flags).
- `src/tui.ts` (new) — Entry point for TUI; export `runTui(options)`. Use `@opentui/react` render loop. Two views: `SessionsList` and `SessionDetail`.
- `src/types.ts` — `ForgeResult` (in `summary.json`) and `SessionEvent` (in `events.jsonl`, from structured-event-log spec) are the data sources.
- `.forge/results/*/summary.json` — Each file is a `ForgeResult`; `sessionId`, `specPath`, `costUsd`, `durationSeconds`, `status` are the relevant fields.
- `.forge/latest-session.json` — Has `logPath` pointing to stream.log; derive `events.jsonl` path by replacing `stream.log` with `events.jsonl` in the same directory.
- `src/display.ts` — ANSI constants and display helpers; reuse color constants where possible outside TUI context.
- No banner in `tui` (interactive mode takes over terminal); suppress all non-TUI output.
- `@opentui/react` uses a React reconciler backed by a Zig renderer; components use standard React hooks. Use `ScrollBox` for log history and a top-level focus/key handler for navigation.
