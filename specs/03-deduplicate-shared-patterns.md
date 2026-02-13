# Deduplicate Shared Patterns in query.ts

## Outcome

Repeated boilerplate across `runSingleSpec`, `runAudit`, and `runReview` is extracted
into shared helpers, reducing duplication without adding unnecessary abstraction.

## Patterns to Extract

### 1. Resolve + validate working directory

Identical pattern appears 3 times:
```typescript
const workingDir = cwd ? (await fs.realpath(cwd)) : process.cwd();
try {
  const stat = await fs.stat(workingDir);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${workingDir}`);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Directory not found: ${workingDir}`);
  throw err;
}
```

Extract to: `async function resolveWorkingDir(cwd?: string): Promise<string>`

### 2. Load config + merge defaults

Same pattern 3 times with different per-command defaults:
```typescript
const config = await loadConfig(workingDir);
const effectiveModel = model || config.model || 'opus';
const effectiveMaxTurns = maxTurns ?? config.maxTurns ?? 250;
const effectiveMaxBudgetUsd = maxBudgetUsd ?? config.maxBudgetUsd ?? 50.00;
```

Extract to: `async function resolveConfig(workingDir: string, overrides: {...}): Promise<{...}>`
The function takes per-command defaults and returns resolved values.

### 3. Batch result type

The inline type `{ spec: string; status: string; cost?: number; duration: number }` is
repeated at `runSpecBatch` return type and `printBatchSummary` parameter. Extract to a
named interface `BatchResult` (in query.ts, not types.ts — it's internal).

## Acceptance Criteria

- `resolveWorkingDir()` replaces the 3 duplicated blocks
- `resolveConfig()` replaces the 3 config-loading blocks
- `BatchResult` interface replaces the 2 inline type annotations
- No behavioral changes — all commands work identically
- TypeScript compiles without errors
- Existing tests still pass
