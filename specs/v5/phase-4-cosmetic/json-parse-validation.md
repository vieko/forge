---
---

# Add runtime validation to JSON.parse call sites

## Outcome

The three identified `JSON.parse()` sites that cast results with `as` are guarded by zod schemas or type guards. Invalid JSON shapes are caught at runtime rather than propagating silently.

## Acceptance Criteria

- `src/specs.ts` line 1078 — `JSON.parse()` result is validated with a zod schema or type guard before use
- `src/core.ts` line 379 — `JSON.parse()` result is validated before use
- `src/db-pipeline-state.ts` lines 89–90 — `JSON.parse()` results are validated before use
- Each site uses `z.object({...}).safeParse()` with a sensible fallback (not a throw) where appropriate
- No over-engineering: schemas are minimal and focused on the parsed shape, not exhaustive
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/specs.ts` line 1078 — manifest JSON parsing
- `src/core.ts` line 379 — session/event JSON parsing
- `src/db-pipeline-state.ts` lines 89–90 — pipeline state JSON parsing
- Zod is already a dependency (via the Agent SDK); no new dependency needed
- Existing `zod` usage in the codebase can serve as a style reference
