---
depends: [execution-mode-isolate.md]
---

# Dependency level consolidation gates for isolated execution

## Outcome

When running in `--isolate` mode with dependency relationships, specs are grouped into dependency levels via topological sort. Level 0 specs (no deps) each get their own worktree and run in parallel. Before level 1 worktrees are created, level 0 results are consolidated into a merged state. This incremental consolidation repeats between each dependency level.

## Acceptance Criteria

- `topoSort()` levels drive worktree creation order in isolate mode
- Level 0 specs fan out into parallel worktrees
- After all level 0 worktrees reach `complete` status, an intermediate consolidation produces a merged branch
- Level 1 worktrees are created from the consolidated state (not from main)
- Process repeats for each subsequent dependency level
- If any spec in a level fails, dependent levels are skipped with a clear message
- Progress display shows level boundaries: `Level 0/2: 3 specs`, `Level 1/2: 2 specs`
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/deps.ts` (topoSort, DepLevel, loadSpecDeps), `src/parallel.ts` (runForge, runSpecBatch), `src/utils.ts` (createWorktree, commitWorktree)
- Current dep-aware execution runs levels sequentially within ONE worktree; this extends it to create separate worktrees per spec within each level
- The intermediate consolidation between levels uses git merge (similar to the final consolidation command)
- `satisfiedDeps` set from manifest is still consulted to skip already-passed specs
