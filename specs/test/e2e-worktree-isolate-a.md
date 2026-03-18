# E2E: Isolate mode — spec A

## Outcome

A marker file exists proving this spec ran in its own isolated worktree.

## Acceptance Criteria

- File `e2e-isolate-a.txt` exists at the project root containing the text `isolate-a-ok`
- TypeScript compiles without errors
- Existing tests still pass
