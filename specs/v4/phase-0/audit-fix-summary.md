---
depends: []
---

# Audit-Fix Loop Summary and Diagnostics

When `forge audit --fix` stops after max rounds with remaining gaps, provide a clear diagnostic of what happened across rounds — what was fixed, what persists, why it didn't converge, and what to do next.

## Problem

The current audit-fix summary shows round counts and costs but doesn't help the user understand:

- Which specific gaps were fixed across rounds vs which persist
- Whether persisting gaps are the same issue failing repeatedly or new issues emerging
- Whether fix attempts ran and failed (verification error) or never ran (cancelled/skipped)
- What the remaining remediation specs actually need (user has to read each file manually)

The user hits "Max rounds reached. Some gaps may remain." and has to manually investigate `remediation/` to figure out what happened.

## Acceptance Criteria

### Enhanced Summary Output

1. **Gap tracking across rounds**: Track each unique gap (by base filename, stripping `r{N}-` prefixes) across all rounds. The summary shows a per-gap timeline:

   ```
   AUDIT-FIX SUMMARY
   ──────────────────────────────────────────────────────────
   Gap Tracking:
     + google-calendar-token-management    r1: found → fixed → r2: clean
     + task-feed-status-badge              r1: found → fixed → r2: clean
     > settings-add-google-calendar        r1: found → fixed → r2: found again → r3: fixed
     x google-calendar-api-and-widget      r1: found → fixed → r2: found again → r3: found again (persists)
   ```

   Legend: `+` resolved, `>` resolved after multiple rounds, `x` unresolved.

2. **Convergence analysis**: After the per-gap timeline, print a one-line diagnosis:
   - All gaps resolved: `"Converged after N round(s). All gaps resolved."`
   - Same gaps repeating: `"Not converging: N gap(s) reappear after fixes. May need manual intervention or spec revision."`
   - Max rounds hit with progress: `"Partial progress: M of N gaps resolved after K rounds. Remaining gaps may need more rounds (--fix-rounds) or manual review."`

3. **Remaining gap summaries**: For each unresolved gap, print a 1-line description extracted from the remediation spec's `## Outcome` section (first sentence only). This tells the user what each gap needs without reading the full file:

   ```
   Remaining gaps:
     x google-calendar-api-and-widget
       "The KB app exposes a /api/ext/calendar endpoint that returns today's Google Calendar events."
       → specs/index-extension/remediation/r3-google-calendar-api-and-widget.md
   ```

4. **Fix attempt status per gap**: For gaps that had fixes run, indicate whether the fix spec passed or failed verification:

   ```
     x google-calendar-api-and-widget
       r1: audit found → run passed → r2: audit found again (fix incomplete)
       r2: audit found → run failed (verification: tsc errors) → r3: audit found again
   ```

### Structured Output

5. **Summary in result JSON**: The audit result `summary.json` includes a `gapTracking` array:

   ```json
   {
     "gapTracking": [
       {
         "name": "google-calendar-api-and-widget",
         "status": "unresolved",
         "rounds": [
           { "round": 1, "action": "found_and_fixed", "fixStatus": "success" },
           { "round": 2, "action": "found_and_fixed", "fixStatus": "error_verification" },
           { "round": 3, "action": "found", "fixStatus": null }
         ]
       }
     ]
   }
   ```

6. **Exit code reflects state**: `forge audit --fix` exits 0 if converged (all gaps resolved), exits 1 if gaps remain. Currently always exits 0.

### Next-Step Hints

7. **Actionable next steps** based on outcome:
   - Converged: `"Next: forge proof <spec-dir>"`
   - Not converging (same gaps): `"The same gaps persist after fixes. Review the remediation specs — they may need manual revision or the original specs may be too broad."`
   - Max rounds with progress: `"Progress is being made. Try: forge audit <spec-dir> --fix --fix-rounds <N+2>"`
   - Fix verification failures: `"Fix attempts failed verification. Check build/test errors in the session logs: forge watch <session-id>"`

## Out of Scope

- Changing the audit prompt or how gaps are detected
- Changing the fix execution strategy (still uses `runForge` on remediation dir)
- Auto-increasing fix rounds
- Splitting or merging remediation specs

## Key Files

- `src/audit.ts` — `runAuditFixLoop()`: track gaps across rounds, enhanced summary, structured output, exit code
- `src/types.ts` — `GapTracking` type for structured gap data
