---
---

# Add zod validation to loadManifest JSON.parse

## Outcome

The `loadManifest()` function in `src/specs.ts` validates the parsed JSON shape with a zod schema instead of using an unsafe `as SpecManifest` cast. Malformed manifest files (valid JSON, wrong shape) are caught at parse time and fall back to an empty manifest.

## Acceptance Criteria

- `src/specs.ts` `loadManifest()` — the `JSON.parse()` result is validated with a zod schema before returning
- Schema covers `{ version: number, specs: array }` at minimum — not exhaustive, just enough to reject wrong shapes
- On validation failure, falls back to `{ version: 1, specs: [] }` (same as current catch behavior)
- The existing try-catch structure is preserved; the zod validation is added inside it
- No new dependencies (zod is already available)
- TypeScript compiles without errors (`bun run typecheck`)
- Existing tests still pass (`bun test`)

## Context

- `src/specs.ts` line 124 currently reads: `return JSON.parse(content) as SpecManifest;`
- The `as SpecManifest` cast is unsafe — if the file contains `{"foo": 42}`, it silently becomes a SpecManifest
- The three other `JSON.parse` sites identified in the original spec are already guarded:
  - `src/specs.ts` `parseCheckResults` — zod `safeParse` + null fallback
  - `src/core.ts` tool input parsing — `z.record().catch({}).parse()` in try block
  - `src/db-pipeline-state.ts` row mappers — `z.array().catch([]).parse()` / `z.record().catch({}).parse()`
- `SpecManifest` type: `{ version: 1, specs: SpecEntry[] }` (defined in `src/types.ts`)
- Use `.catch({ version: 1, specs: [] }).parse()` or `safeParse()` with fallback — either pattern is fine
