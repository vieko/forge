---
---

# Architecture decision: DB-primary persistence model

## Outcome

A documented architectural decision defines what data is DB-primary, what remains as filesystem artifacts, how recovery works when the DB is lost, and what the migration boundary is. Implementation specs depend on this decision.

## Acceptance Criteria

- A decision document exists (can be inline in this spec's implementation or a separate `.bonfire/docs/db-primary.md`) that covers:
  1. **What is DB-primary**: runs, sessions (metadata), tasks, pipelines, stages, gates
  2. **What remains as filesystem artifacts**: `result.md` (human-readable run output), `events.jsonl` (append-only event log for streaming/watch), worktree state (git manages this)
  3. **What is removed**: `summary.json` per-run files, `backfillRuns()`, `backfillSessions()`, `getDbWithBackfill()` wrapper, `FileSystemStateProvider`, filesystem-based session loading in TUI
  4. **Recovery expectations**: if `.forge/forge.db` is deleted, historical run/session/task/pipeline data is lost. `result.md` files survive but are not machine-indexed. `events.jsonl` files survive for manual inspection. Document this trade-off in the decision doc; any user-facing warnings or documentation updates belong in implementation specs
  5. **Migration boundary**: the migration is internal to `.forge/` — no user-facing spec files, config, or CLI behavior changes. `forge status`, `forge stats`, `forge specs`, `forge watch` all work identically from the user's perspective. The only observable change is that `.forge/results/*/summary.json` files stop being created
  6. **Rollback strategy**: since this is local-only state, rollback is "delete DB, lose history, start fresh." No backward-compatible dual-write period needed — this is a clean cut
  7. **DB durability**: WAL mode with `wal_autocheckpoint=1000` is already configured. No additional backup mechanism required for local development tool. Optional: document `sqlite3 .forge/forge.db .dump` for users who want manual backups
- The decision is reviewed by the implementer before starting implementation specs
- No code changes in this spec — decision document only (no warnings, no documentation updates, no implementation side effects)

## Context

- Current state: filesystem is "authoritative" for runs and sessions, DB is derived index with ~300 lines of backfill code. But tasks, executor state, and pipeline state (via TUI) are already DB-only. This is a split-brain model
- Motivation: phase-2 (http-api + remote dashboard) will add another DB consumer. Building a remote dashboard on top of a "cache" is architecturally unsound
- Risk: DB corruption or deletion loses data. Mitigated by: WAL mode durability, local-only scope (no distributed consistency concerns), and the fact that forge run results are reflected in the git history (commits, code changes) which is the ultimate source of truth
- `src/db.ts` lines 568–855 — backfill code to be removed
- `src/pipeline-state.ts` — FileSystemStateProvider to be removed
- `src/tui.tsx` — filesystem fallback paths to be removed
