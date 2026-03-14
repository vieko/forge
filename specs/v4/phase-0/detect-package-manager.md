---
depends: []
---

# Detect Package Manager

Shared `detectPackageManager()` utility that both `verify.ts` and `workspace.ts` use to determine the correct package manager for a project. Lockfile-first detection, single source of truth.

## Problem

Two independent detection systems hardcode wrong package managers:

- `workspace.ts:detectSetupCommands()` — sees `package.json` → always runs `bun install`
- `verify.ts:detectVerification()` — sees `package.json` → always emits `npm run build` / `npm test`

Both fail on pnpm projects (forge's primary target). The monorepo detector in `verify.ts` knows about pnpm but `detectVerification` ignores it.

## Acceptance Criteria

### Shared Utility

1. **`detectPackageManager(workingDir: string): Promise<PackageManager>`** returns one of `'bun' | 'pnpm' | 'npm' | 'yarn' | null`. Detection order (first match wins):

   | Check | Result |
   |-------|--------|
   | `bun.lockb` or `bun.lock` exists | `bun` |
   | `pnpm-lock.yaml` exists | `pnpm` |
   | `yarn.lock` exists | `yarn` |
   | `package-lock.json` exists | `npm` |
   | `package.json` exists (no lockfile) | `npm` (default) |
   | No `package.json` | `null` |

2. **Exported from `src/utils.ts`** (or a new `src/detect.ts` if utils is too large). No new dependencies.

### Workspace Hooks Integration

3. **`workspace.ts:detectSetupCommands()`** uses `detectPackageManager()` to emit the correct install command:

   | Package Manager | Command |
   |-----------------|---------|
   | `bun` | `bun install` |
   | `pnpm` | `pnpm install` |
   | `npm` | `npm install` |
   | `yarn` | `yarn install` |
   | `null` | (no Node setup command) |

4. **Cargo and Go detection unchanged** — they're already correct.

### Verification Integration

5. **`verify.ts:detectVerification()`** uses `detectPackageManager()` to emit the correct run/test commands:

   | Package Manager | TypeScript | Build | Test |
   |-----------------|-----------|-------|------|
   | `bun` | `bun run tsc --noEmit` | `bun run build` | `bun test` |
   | `pnpm` | `pnpm exec tsc --noEmit` | `pnpm run build` | `pnpm test` |
   | `npm` | `npx tsc --noEmit` | `npm run build` | `npm test` |
   | `yarn` | `yarn tsc --noEmit` | `yarn run build` | `yarn test` |

6. **Monorepo scoping unaffected** — `scopePnpmCommand()` and `scopeNxCommand()` continue to work as-is. They already rewrite commands correctly once they're in the monorepo path.

### Tests

7. **Unit tests for `detectPackageManager()`** — test each lockfile, precedence when multiple exist, no `package.json` case, `package.json` without lockfile fallback.

8. **Update existing `workspace.test.ts`** and `verify.test.ts` to cover pnpm/yarn/bun detection paths.

## Out of Scope

- Detecting package manager version (e.g., pnpm 8 vs 9)
- `packageManager` field in `package.json` (corepack) — lockfile detection is sufficient and more reliable
- Monorepo-aware install commands (e.g., `pnpm install --filter`) — workspace setup needs full install, not filtered
- Changing config override behavior — explicit `.forge/config.json` setup commands still take precedence

## Key Files

- `src/utils.ts` (or `src/detect.ts`) — new `detectPackageManager()`
- `src/workspace.ts` — update `detectSetupCommands()` to use it
- `src/verify.ts` — update `detectVerification()` to use it
