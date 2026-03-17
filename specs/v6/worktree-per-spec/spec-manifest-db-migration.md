---
depends: [spec-entries-schema.md]
---

# Migrate spec manifest from JSON file to SQLite

## Outcome

All spec manifest reads and writes go through the SQLite `spec_entries` and `spec_runs` tables. The `withManifestLock` file-locking pattern is replaced by SQLite transactions. The `.forge/specs.json` file is written as a read-only export after each DB write for backward compatibility and human readability. Existing JSON manifest data is auto-migrated on first DB access.

## Acceptance Criteria

- `loadManifest()` reads from `spec_entries` + `spec_runs` tables and returns a `SpecManifest` object
- `saveManifest()` writes to DB tables via transaction, then exports JSON to `.forge/specs.json`
- `withManifestLock()` replaced by a `withSpecTransaction()` function that uses SQLite transactions
- All callers of `withManifestLock` updated: `findOrCreateEntry`, `updateEntryStatus`, `addSpecs`, `resolveSpecs`, `unresolveSpecs`, `pruneSpecs`, `reconcileSpecs`, `resetRunningSpecs`
- Auto-migration: when `spec_entries` table is empty and `.forge/specs.json` exists, JSON data imported into DB on first access
- File lock utilities (`acquireLock`, `releaseLock`, `.forge/specs.json.lock`) removed or deprecated
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/specs.ts` (withManifestLock, loadManifest, saveManifest, all CRUD operations), `src/db.ts` (spec_entries/spec_runs tables), `src/types.ts` (SpecManifest, SpecEntry, SpecRun)
- The migration must be idempotent: running it multiple times produces the same result
- JSON export preserves the `{ version: 1, specs: [...] }` format for tools that read it
- Callers in `src/run.ts`, `src/parallel.ts`, `src/audit.ts`, `src/define.ts`, `src/proof.ts` all use `withManifestLock` indirectly through specs.ts functions
- DB transactions eliminate the 30-second stale lock TTL and exponential backoff retry logic
