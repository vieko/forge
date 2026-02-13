# Fix types.ts Staleness and Missing Values

## Outcome

Type definitions in `src/types.ts` accurately reflect the current implementation.

## Issues

1. **Stale JSDoc on `maxTurns`** (line 16): Says `(default: 100)` but actual default is 250
   in both index.ts and query.ts.

2. **ForgeResult.type missing 'review'** (line 72): Type is `'run' | 'audit'` but `runReview`
   sets `type: 'run'` with an apologetic comment. Should be `'run' | 'audit' | 'review'`.
   Update `runReview` to set `type: 'review'`.

## Acceptance Criteria

- `maxTurns` JSDoc says `(default: 250)`
- `ForgeResult.type` includes `'review'` as a valid value
- `runReview()` in query.ts sets `type: 'review'` (remove the comment about using 'run')
- TypeScript compiles without errors
- Existing tests still pass
