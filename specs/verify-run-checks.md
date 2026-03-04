---
depends: [verify-proof-parser.md]
---

# Automated check execution for forge verify

## Outcome

`src/proof-runner.ts` exports `runVerify(options: VerifyOptions): Promise<void>`. For each proof file it finds in `proofDir`, it builds an outcome-focused prompt containing the proof's automated check items and calls `runQuery()` once. The agent executes all automated checks and returns a structured pass/fail summary. Results are saved to `.forge/results/` with `type: 'verify'`. Proofs are processed sequentially, one at a time.

## Acceptance Criteria

- `src/proof-runner.ts` created and exports `runVerify(options: VerifyOptions): Promise<void>`
- Each proof file triggers exactly one `runQuery()` call — no procedural check execution outside the agent
- The prompt instructs the agent to run every item in the proof's "Automated Tests" section and report pass/fail per item, ending with a clear overall result (`ALL PASS` or `FAILURES: <n>`)
- `runQuery()` is called with defaults: model `sonnet`, max turns `100`, max budget `$5.00`, overridable via options
- Each run's outcome is saved via `saveResult()` to `.forge/results/` with `type: 'verify'` in `ForgeResult`
- `showBanner()` is called at startup unless `options.quiet` is true
- After all proofs finish, `printRunSummary()` shows total duration, cost, and a next-step hint pointing to `forge prove` or `forge audit`
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/proof-runner.ts` — new file; named to avoid conflict with existing `src/verify.ts` (which handles build/test verification for the agent loop)
- `src/prove.ts` — direct pattern to follow: single `runQuery()` per item, sequential loop, `showBanner()`, `printRunSummary()`, `saveResult()`
- `src/core.ts` — `runQuery(config: QueryConfig): Promise<QueryResult>`; pass `abort.getAbortController()` for graceful shutdown
- `src/abort.ts` — `getAbortController()`, `isInterrupted()` for Ctrl-C handling
- `src/utils.ts` — `saveResult()`, `resolveConfig()`, `execAsync()`
- `src/display.ts` — `showBanner()`, `printRunSummary()`, `DIM`, `RESET`, `CMD` ANSI constants
- `src/types.ts` — `VerifyOptions`, `VerifyResult`, `ForgeResult` (set `type: 'verify'`)
- Agent prompt must include "Do not use emojis in your output"
- The prompt passes proof content (automated checks only) not the full proof file — human steps are extracted separately and held for PR creation
