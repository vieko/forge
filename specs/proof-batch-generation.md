---
depends: [proof-rename.md]
---

# Rewrite proof generation: batch agent calls and actual test file output

## Outcome

`forge proof <spec-dir>` makes a single batched agent call (or one call per logical group) that reads all spec files and writes actual `.test.ts` files into structured output subdirectories, a consolidated `manual.md` human checklist, and a `manifest.json` that maps specs to generated test files. A `ProofManifest` TypeScript type is defined as the contract between generation and verification.

## Acceptance Criteria

- `forge proof <spec-dir>` makes a single agent query for all specs (or at most one per batch group determined by directory or size heuristic) rather than one SDK `query()` call per spec file
- The agent writes new `.test.ts` files into `<outputDir>/unit/` and/or `<outputDir>/integration/` using the project's test framework (auto-detected from `package.json` devDependencies: vitest, jest, or bun test)
- The agent writes a single `<outputDir>/manual.md` with all human-only verification steps consolidated across all specs (not one per spec)
- The agent writes `<outputDir>/manifest.json` whose structure matches the `ProofManifest` interface: `{ generatedAt, specDir, entries: [{ specFile, category, testFile, description }], manualCheckCount }`
- `ProofManifest` and `ProofManifestEntry` interfaces are added to `src/types.ts`
- Single-spec mode (`forge proof <single-spec.md>`) still works and writes to the same structured output (unit/ or integration/ + manual.md + manifest.json)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/proof.ts` — full rewrite of `runProof()`: replace per-spec for-loop with batch prompt construction; new agent prompt instructs the agent to write `.test.ts` files and `manifest.json` instead of a markdown verification document
- `src/types.ts` — add `ProofManifest` and `ProofManifestEntry` interfaces alongside existing `ProofOptions` and `VerifyOptions`
- Batch prompt design: include all spec file contents in a single prompt with the full codebase available; instruct agent to auto-detect test framework from `package.json`; require agent to write each test file before writing `manifest.json`; require `manual.md` for any step that cannot be automated
- Output directory layout (outputDir defaults to `.forge/proofs/`):
  - `unit/` — isolated unit test files (one or more `.test.ts` per spec group)
  - `integration/` — cross-module test files
  - `manual.md` — consolidated human checklist
  - `manifest.json` — ProofManifest JSON
- Agent prompt constraint: do not write generic verification commands (tsc, lint, full test suite) — those are prerequisites run separately; only write spec-specific tests
- Size heuristic for batching: if spec count exceeds a threshold (e.g. 20), group specs by subdirectory or in chunks of ~20 to avoid context window limits; each group gets one agent call
- `src/display.ts` — batch progress display should show "Generating tests for N specs" rather than per-spec labels
- `src/pipeline.ts` — `runProof()` call in the prove executor should work unchanged since the function signature is preserved; `artifacts.proofDir` still points to outputDir
- The old per-spec markdown output format is replaced entirely; no backward compatibility with `.md` proof files is needed in the generator
