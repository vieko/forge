---
depends: [e2e-worktree-create.md]
---

# E2E: Worktree registry entry

## Outcome

A marker file exists proving a second worktree was created, demonstrating that the registry tracks multiple worktrees and dependency ordering works.

## Acceptance Criteria

- File `e2e-worktree-registry.txt` exists at the project root containing the text `worktree-registry-ok`
- TypeScript compiles without errors
- Existing tests still pass
