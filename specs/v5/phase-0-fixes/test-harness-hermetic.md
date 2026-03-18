---
---

# Test git operations are hermetic (no GPG signing)

## Outcome

Tests that create real git commits are isolated from the user's global git config. They never fail due to GPG signing or other global git settings. A shared test utility provides this isolation for all affected test files.

## Acceptance Criteria

- All test files that call `git commit` are protected from `commit.gpgSign=true` and other user-global git settings
- The fix lives in a shared location (e.g. `src/test-utils.ts` or a `beforeAll` hook), not duplicated per-test
- `src/worktree.test.ts` and `src/pipeline.test.ts` use the shared hermetic setup
- Tests pass on machines with `commit.gpgSign=true` in their global git config
- The isolation approach uses `GIT_CONFIG_GLOBAL=/dev/null` or equivalent git config flag (`-c commit.gpgSign=false`)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/worktree.test.ts` — creates real git commits; needs hermetic setup
- `src/pipeline.test.ts` — creates real git commits; needs hermetic setup
- Consider a shared `src/test-utils.ts` with a `withHermeticGit()` helper or exported env setup for `beforeAll`
- Strategy: `GIT_CONFIG_GLOBAL=/dev/null` env var or `git -c commit.gpgSign=false` for all commit calls in tests
