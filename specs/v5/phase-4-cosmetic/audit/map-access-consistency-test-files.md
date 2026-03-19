---
---

# Standardize Map access pattern in test files

## Outcome

The two remaining test files that use the old `has()`/`get()!` Map grouping pattern are updated to the nullish-coalescing form used everywhere else in the codebase, completing the single-idiom goal.

## Acceptance Criteria

- `src/tui-views.test.ts` lines 341-342: replace `if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(entry);` with the `const arr = groups.get(key) ?? []; arr.push(entry); groups.set(key, arr);` form
- `src/tui.test.ts` lines 526-527: replace `if (!groups.has(dir)) groups.set(dir, []); groups.get(dir)!.push(spec);` with the `const arr = groups.get(dir) ?? []; arr.push(spec); groups.set(dir, arr);` form
- No other sites in the codebase use the `if (!map.has(k)) map.set(k, []); map.get(k)!.push(x)` pattern
- TypeScript compiles without errors
- Existing tests still pass

## Context

All production source sites were already converted. These two test files are the only remaining instances of the old pattern, found via `rg '\.get\([^)]+\)!\.push\(' src/`.
