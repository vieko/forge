# E2E: Worktree creation

## Outcome

A marker file exists proving a worktree was created and the agent executed inside it.

## Acceptance Criteria

- File `e2e-worktree-create.txt` exists at the project root containing the text `worktree-create-ok`
- TypeScript compiles without errors
- Existing tests still pass
