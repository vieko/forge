---
depends: [proof-batch-generation.md]
---

# Update verify to consume manifest.json and run actual test files

## Outcome

`forge verify <proof-dir>` reads `manifest.json` to discover generated test files and executes them directly using the project's test runner, without an agent SDK call for automated checks. Human verification steps come from the single consolidated `manual.md`. The PR body reflects the new test-file-based results format.

## Acceptance Criteria

- `forge verify <proof-dir>` reads `<proof-dir>/manifest.json` (written by `forge proof`) to find test files; exits with a clear error if `manifest.json` is missing
- Verify executes test files by running the project's test runner (`bun test <path>`, `vitest run <path>`, or `npm test -- <path>`) directly via `execAsync`, without spawning an agent SDK call for automated checks
- Human verification steps are read from `<proof-dir>/manual.md` and surfaced as PR checklist items; if `manual.md` is absent, the human section of the PR is omitted
- `VerifyResult` in `src/types.ts` is updated to store `testFile` (path), `exitCode` (number), and `stderr` (string) instead of `automatedPassed`/`automatedTotal` check counts
- PR body includes a results table (test file, pass/fail, duration) and all `manual.md` items as `- [ ]` checkboxes
- `forge verify --dry-run` prints the test commands that would be run (one per test file) without executing them
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/proof-runner.ts` — replace `parseProofs()` (markdown section parser) with `readProofManifest()` that reads and validates `manifest.json`; replace the per-proof `runQuery()` loop with direct `execAsync()` calls for each test file; update `buildPRBody()` to use the new result shape
- `src/types.ts` — update `VerifyResult` interface: replace `automatedPassed: number` / `automatedTotal: number` / `humanSteps: string[]` with `testFile: string` / `exitCode: number` / `stderr: string`; `humanSteps` moves to a top-level field on the verify run (from `manual.md`) rather than per-result
- `src/proof-runner.ts` — `ParsedProof` interface is replaced by `ProofManifest` (imported from `src/types.ts`); `parseProofs()` is deleted or repurposed
- Test runner detection: check `package.json` devDependencies for `vitest`, `jest`, or presence of `bun` lockfile; default to `npm test`
- `createVerifyPR()` — PR title format unchanged (`Verify: <dirname>`); table columns change to File / Status / Duration; human checklist sourced from `manual.md` content rather than per-proof `humanSteps` arrays
- `src/pipeline.ts` — the `runVerify()` call in the verify executor passes `proofDir` as before; no changes needed to the pipeline orchestrator
- `src/index.ts` — `verify` command definition unchanged; `VerifyOptions.proofDir` remains the primary argument
- Agent SDK calls (`runQuery`) are removed from `runVerify()`; this eliminates the nested session guard concern for verify
- Display: per-test-file status icons (`+` pass, `x` fail) replace per-proof icons; overall summary still shows passed/failed counts
