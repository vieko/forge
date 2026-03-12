---
depends: [db-core.md]
---

# Forge Configuration File

## Outcome

Forge has a `.forge/config.json` file for user-configurable settings that don't belong in code, environment variables, or spec frontmatter. The file is auto-created with defaults on first access, validated at read time, and gitignored (local-only, like the database).

## Acceptance Criteria

- `.forge/config.json` created lazily on first read via `getConfig(workingDir)` — returns defaults if file doesn't exist
- Schema validated with zod at load time; unknown keys ignored (forward-compatible), invalid values fall back to defaults with a warning
- Initial schema fields: `setup` (string[]), `teardown` (string[]), `setupTimeout` (number, ms), `dbProvider` ("sqlite" | "turso"), `apiPort` (number), `apiToken` (string | null)
- `getConfig()` caches per working directory (same singleton pattern as `getDb()`)
- File added to `.forge/.gitignore` (local-only — each machine may have different config)
- `forge config` CLI command to view current config (read-only, no set command — edit the file directly)
- TypeScript compiles without errors

## Context

- Relevant files: `src/utils.ts` (ensureForgeDir, config patterns), `src/types.ts` (type definitions)
- Referenced by: `workspace-hooks.md` (setup/teardown arrays, setupTimeout), `http-api.md` (apiPort, apiToken), `sync-layer.md` (dbProvider)
- The config file is strictly for local machine settings — project-level configuration belongs in CLAUDE.md or spec frontmatter
- Environment variables take precedence over config file values (e.g. `FORGE_API_TOKEN` overrides `config.apiToken`)
- Do not over-design: start with the fields needed by other v4 specs, extend later as needed
