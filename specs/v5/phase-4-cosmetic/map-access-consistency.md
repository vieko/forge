---
---

# Standardize Map access pattern across codebase

## Outcome

All Map grouping patterns use a consistent `get(k) ?? []` with re-set approach (or a `getOrInsert` helper) rather than mixing non-null assertions after `.has()` checks. The codebase has one Map access idiom.

## Acceptance Criteria

- The pattern `if (!map.has(k)) map.set(k, []); map.get(k)!.push(x)` is replaced with the nullish-coalescing form at all identified sites
- Chosen pattern: `const arr = map.get(k) ?? []; arr.push(x); map.set(k, arr);` — or a `getOrInsert` utility if one is extracted
- Applied consistently across: `src/specs.ts:938`, `src/audit.ts:532,602,606`, `src/mcp.ts:108,156`, `src/status.ts:154,208`
- Sites already using the consistent pattern (`src/stats.ts:167`, `src/proof.ts:179`) are left unchanged
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/specs.ts` line 938 — non-null assertion after `.has()` check
- `src/audit.ts` lines 532, 602, 606 — same pattern
- `src/mcp.ts` lines 108, 156 — same pattern
- `src/status.ts` lines 154, 208 — same pattern
- `src/stats.ts` line 167 and `src/proof.ts` line 179 — already use the preferred nullish-coalescing form; reference these as the target style
- Optionally extract a `getOrInsert<K, V>(map: Map<K, V[]>, key: K): V[]` helper to `src/utils.ts`
