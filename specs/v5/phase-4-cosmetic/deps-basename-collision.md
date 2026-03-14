---
---

# Dependency validation uses full spec key, not basename

## Outcome

`validateDeps()` in `src/deps.ts` compares `depends:` entries against full spec keys (relative paths). Specs with the same filename in different directories are correctly distinguished. Bare filenames in `depends:` frontmatter still work as a backward-compatible fallback.

## Acceptance Criteria

- `validateDeps()` builds manifest lookup structures using full spec keys (relative paths) as primary identifiers
- Specs `auth/login.md` and `setup/login.md` are treated as distinct entries; neither incorrectly shadows the other
- Existing `depends:` frontmatter using bare filenames (e.g. `depends: [login.md]`) continues to work via basename fallback
- The `specKey()` function from `src/specs.ts` is used (or its logic is applied) for key generation
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/deps.ts` lines 154–194 — `validateDeps()` function
- `src/deps.ts` line 163 — `const basename = path.basename(entry.spec)` used as the only key; replace with full key as primary
- `src/deps.ts` lines 165–169 — `manifestPassedNames` and `manifestNonPassedNames` built from basenames; switch to full keys with basename fallback
- `src/specs.ts` — `specKey()` function provides the canonical relative-path key format
