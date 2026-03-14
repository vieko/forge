---
---

# Replace require.resolve with import.meta.url for binary resolution

## Outcome

The TUI and executor both resolve the forge binary path using `import.meta.url`. A shared `getForgeEntryPoint()` helper in `src/utils.ts` provides this resolution. `require.resolve` is gone from production source.

## Acceptance Criteria

- `require.resolve('./index.js')` is removed from `src/tui.tsx` (three occurrences at lines 1635, 2241, 2535)
- A `getForgeEntryPoint()` helper is added to `src/utils.ts` using `import.meta.url`-based resolution: `path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'index.js'))`
- `src/tui.tsx` calls `getForgeEntryPoint()` at all three sites
- `src/executor.ts` also uses `getForgeEntryPoint()` (replacing its inline `import.meta.url` logic at line 95)
- Binary resolution produces the same path before and after the change
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/tui.tsx` lines 1635, 2241, 2535 — `require.resolve('./index.js')` pattern to replace
- `src/executor.ts` line 95 — existing `import.meta.url` pattern; extract to shared helper
- `src/utils.ts` — add `getForgeEntryPoint()` helper
