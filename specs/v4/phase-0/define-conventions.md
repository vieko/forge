---
---

# Define Reads AGENTS.md Conventions

## Outcome

`forge define` reads `AGENTS.md` if present in the target repository, alongside existing project instruction sources (CLAUDE.md), and treats it as a canonical repository convention file. Generated specs reflect the conventions declared in AGENTS.md.

## Acceptance Criteria

- `forge define` checks for `AGENTS.md` at the target repo root and includes its contents in the define prompt context
- AGENTS.md conventions take precedence over inferred codebase patterns (same as CLAUDE.md behavior)
- If both CLAUDE.md and AGENTS.md exist, both are included (AGENTS.md complements, does not replace)
- No error if AGENTS.md does not exist — purely additive
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/define.ts` (prompt construction at ~line 80), `src/core.ts` (CLAUDE.md auto-discovery via SDK `settingSources`)
- Superset uses `AGENTS.md` as the canonical convention file for all coding agents (Claude, Codex, Cursor, Warp) — see `.bonfire/docs/superset-deep-dive.md`
- The SDK auto-discovers CLAUDE.md via `settingSources: ['user', 'project']`. AGENTS.md is not auto-discovered by the SDK, so `forge define` must read it explicitly and inject into the prompt
- This is low-effort: read file if exists, prepend to define prompt context
