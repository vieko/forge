---
depends: [sibling-worktree-creation.md, workspace-hooks-extraction.md]
---

# Monorepo-aware worktree creation and setup

## Outcome

Worktree creation and workspace setup correctly handle monorepo structures where specs target a specific package/app within a larger repository. Setup hooks run at the correct scope (root lockfile install + package-level build). Verification scopes to the affected package, not the entire monorepo.

## Acceptance Criteria

- Spec frontmatter supports optional `scope: packages/api` (or similar) to identify the target package within a monorepo
- Worktree creation clones the full repo (git worktrees always do), but workspace setup is scope-aware: root-level lockfile install first, then package-level build/setup if scope is specified
- Monorepo detection reuses existing logic from `src/verify.ts` (monorepo detection + scoping)
- Verification during run and consolidation scopes to the affected package(s): type-check and tests run from the package directory, not the repo root
- When multiple worktrees target different packages in the same monorepo, consolidation merges cleanly (non-overlapping package directories reduce conflicts)
- `forge consolidate` incremental type-check runs at the package scope first, then repo root if a root tsconfig exists
- Setup hooks respect workspace protocol: `bun install` / `pnpm install` at repo root installs all packages; no per-package install needed for hoisted lockfiles
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/verify.ts` (detectVerification, monorepo detection/scoping), `src/workspace.ts` or `src/pipeline.ts` (workspace hooks), `src/utils.ts` (createWorktree)
- The main target project (GTM) is a monorepo — this spec is practically required
- Monorepo package managers (pnpm workspaces, bun workspaces, turborepo) handle root-level install differently; the existing `detectPackageManager()` in `src/utils.ts` already handles detection
- Scope is optional: specs without a `scope` field default to repo-root verification (current behavior)
- Verification scoping already exists in `src/verify.ts` for monorepo contexts; this spec ensures it integrates with worktree-per-spec execution
