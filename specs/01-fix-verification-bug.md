# Fix Verification Failure Saved as Success

## Outcome

When verification fails on the final attempt (attempt 3/3), the run is correctly
recorded as a failure instead of silently falling through to `status: 'success'`.

## Current Bug

In `runSingleSpec()` (query.ts), the verification loop:

```
while (verifyAttempt < maxVerifyAttempts) {
  const qr = await runQuery({...});
  if (!verification.passed) {
    verifyAttempt++;
    if (verifyAttempt < maxVerifyAttempts) {
      continue; // retry
    } else {
      // prints error, FALLS THROUGH to success save
    }
  }
  // saves forgeResult with status: 'success'
  return forgeResult;
}
```

On the 3rd failure, `verifyAttempt` becomes 3, the `else` branch prints errors,
then execution falls through to the `forgeResult` block which saves `status: 'success'`.

## Fix

After the final verification failure (the `else` branch), save the result with a
failure status and throw a `ForgeError` — same pattern used for other error paths.
The status should reflect that verification failed (e.g. `'error_execution'` with
an error message indicating verification failure).

## Acceptance Criteria

- A run that fails verification 3 times is saved with a non-success status
- The error message indicates verification failure
- `ForgeError` is thrown with the result attached (for cost tracking)
- `forge status` shows the run as failed
- `--rerun-failed` picks up verification-failed specs
- Existing tests still pass
- TypeScript compiles without errors
