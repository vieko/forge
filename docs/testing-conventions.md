# Forge Testing Conventions

## Hermetic Git

Any test that creates a real repository or real commits must be hermetic.

Required rules:

- ignore user-global and system Git config during tests
- provide a deterministic test identity for author and committer
- make teardown tolerate partially initialized setup

Preferred pattern:

- use the shared hermetic Git helper from `src/test-utils.ts`
- configure local repo identity in helpers that call `git commit`

## Test Layers

Use names and assertions that match the layer being tested.

- Unit tests: pure transforms, DB helpers, query parsing, formatting
- Integration tests: command handlers, runtime orchestration, repo/worktree behavior, persisted state transitions
- Surface tests: CLI registration, MCP tool wiring, TUI entry points and public rendering contracts

Do not describe a DB-only assertion as CLI, MCP, or TUI coverage.

## Proof-Generated Tests

Proof-generated tests are useful, but they should either:

- validate a real public surface, or
- be explicitly named and scoped as unit/data-layer coverage

Before landing a new proof-generated file:

1. Check for an existing hand-written suite in the same behavior area.
2. Decide which file is canonical.
3. Delete or merge near-duplicate assertions instead of keeping both.

## Duplication Policy

Avoid parallel suites that assert the same helper behavior with slightly different fixtures.

When overlap exists:

- keep the higher-signal, better-named suite
- move any unique cases into that canonical file
- remove the lower-signal duplicate

## Practical Goal

The suite should be:

- reliable on clean machines
- honest about which layer it covers
- cheap to maintain when proof output evolves
