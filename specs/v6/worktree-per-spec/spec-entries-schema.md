# Spec entries and runs tables in SQLite

## Outcome

The SQLite database has `spec_entries` and `spec_runs` tables that mirror the data currently stored in `.forge/specs.json`. CRUD functions exist for inserting, querying, updating, and deleting spec entries and their associated run history. This is the foundation for eliminating file-based manifest locking.

## Acceptance Criteria

- `spec_entries` table created with columns: id (TEXT PK), spec (TEXT, unique), status (TEXT), source (TEXT), work_group_id (TEXT nullable), created_at (TEXT), updated_at (TEXT)
- `spec_runs` table created with columns: id (TEXT PK), spec_entry_id (TEXT FK), run_id (TEXT), timestamp (TEXT), status (TEXT), cost_usd (REAL), duration_seconds (REAL), num_turns (INTEGER), verify_attempts (INTEGER)
- DB migration increments schema version in `initDb()` migration chain
- CRUD functions exported: `insertSpecEntry`, `getSpecEntry`, `getSpecEntryByPath`, `updateSpecEntryStatus`, `listSpecEntries`, `deleteSpecEntry`
- CRUD functions exported: `insertSpecRun`, `getSpecRunsByEntry`, `getLatestSpecRun`
- Indexes on spec_entries.status, spec_entries.work_group_id, spec_runs.spec_entry_id, spec_runs.run_id
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/db.ts` (migration chain, initDb, existing tables: runs, sessions, tasks, pipelines, stages, gates), `src/types.ts` (SpecEntry, SpecRun, SpecManifest types)
- Current schema version is 8; this adds version 9
- Follow existing migration pattern: version check + CREATE TABLE IF NOT EXISTS + indexes
- Field types must align with existing SpecEntry and SpecRun TypeScript types
- WAL mode and busy_timeout already configured in initDb
