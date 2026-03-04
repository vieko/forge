---
depends: [verify-run-checks.md]
---

# GitHub PR creation for forge verify

## Outcome

After all proofs have been processed, `runVerify()` creates a **single** GitHub PR that combines results from the entire verify run. The PR body includes an automated results summary table (each proof's pass/fail status, check counts, cost, duration) followed by a `## Human Verification` section aggregating every human-only step from all proofs as markdown task items (`- [ ]`). If any automated check in any proof fails, PR creation is skipped. In `--dry-run` mode the PR title and body are printed to stdout without creating a PR.

## Acceptance Criteria

- `gh pr create --title "..." --body "..."` is called via `execAsync()` exactly once after all proofs finish, only when every proof's automated checks pass
- PR title follows the pattern `Verify: <proof-dir-basename>` (e.g. `Verify: gtmeng-590` when proofDir is `.forge/proofs/gtmeng-590`)
- PR body starts with a `## Summary` section containing a markdown table with columns: Proof, Status, Checks, Cost, Duration — one row per proof
- PR body contains a `## Human Verification` section aggregating all human steps from all proofs, grouped by proof name, formatted as `- [ ] <step>`
- If any automated check in any proof fails, PR creation is skipped and the failure summary is printed clearly; the command exits with a non-zero code
- In `--dry-run` mode, the would-be PR title and body are printed to stdout (using `CMD` cyan colour for the `gh pr create` command line); no PR is created and the command exits cleanly with code 0
- If `gh` is unavailable or returns a non-zero exit code, the error is surfaced without crashing; verify still completes and prints results
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/proof-runner.ts` — PR creation runs once at the end of `runVerify()`, after all proofs are processed; collect `VerifyResult[]` during the loop and pass to a `createVerifyPR()` helper
- `src/utils.ts` — `execAsync(cmd, { cwd })` for running `gh pr create`; wrap in try/catch to surface `gh` errors gracefully
- `src/display.ts` — `CMD` (cyan) constant for highlighting the would-be command in dry-run output; `DIM`/`RESET` for surrounding prose
- Human steps come from the proof parser output (Manual Verification + Visual Checks sections); Edge Cases are excluded from the task list
- PR is created against whichever branch is currently checked out; no branch flags are passed to `gh`
- The summary table is built from `VerifyResult[]` — no extra agent query needed
