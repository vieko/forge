---
---

# Spec manifest has version migration scaffolding

## Outcome

`loadManifest()` calls a `migrateManifest()` function after parsing. The function is a no-op passthrough for version 1 but establishes the migration pattern for future schema changes.

## Acceptance Criteria

- A `migrateManifest()` function exists in `src/specs.ts`
- `migrateManifest()` checks the `version` field and returns the manifest unchanged for version 1
- `loadManifest()` calls `migrateManifest()` after JSON parsing, before returning
- The function signature is extensible: adding a version 2 branch does not require changing callers
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/specs.ts` line 124 — manifest `version: 1` field
- `src/specs.ts` — `loadManifest()` function; call `migrateManifest()` after parse
- The function is intentionally simple: a switch/if on `manifest.version` returning the (possibly transformed) manifest
- This is scaffolding only; no actual migration logic is needed since only version 1 exists
