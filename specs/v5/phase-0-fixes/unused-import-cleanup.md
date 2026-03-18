---
---

# Remove unused stat import from file-watcher.ts

## Outcome

`src/file-watcher.ts` has no dead imports. The unused `stat` import from `fs/promises` is removed.

## Acceptance Criteria

- `import { stat } from 'fs/promises'` (or equivalent) is removed from `src/file-watcher.ts`
- No other code in the file references `stat` after removal
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/file-watcher.ts` line 4 — `import { stat } from 'fs/promises'` is imported but never called in the file
- This is the last known dead import in production source after prior ESM cleanup
