---
---

# Verification warns when no build/test commands are detected

## Outcome

When `detectVerification()` finds no applicable build or test commands, a visible warning is emitted and the result carries a `skipped: true` flag. Callers can distinguish "passed verification" from "verification skipped."

## Acceptance Criteria

- When no commands are detected, a warning `[forge] No build/test commands detected — verification skipped` is logged to stderr or console
- The verification result includes a `skipped: true` field when no commands were found
- Callers that check `result.passed` still work correctly (skipped counts as passed to avoid breaking pipelines)
- Projects that legitimately have no build step are not failed — the warning is informational only
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/verify.ts` line 430 — currently returns `{ passed: true }` silently when no commands detected
- The `skipped` field needs to be added to the return type for `runVerification()` or its result shape
- Display code in `src/run.ts` or `src/display.ts` may benefit from surfacing this flag, but UI changes are optional
