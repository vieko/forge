# E2E: Isolate mode — spec B

## Outcome

A marker file exists proving this spec ran in its own isolated worktree, parallel to spec A.

## Acceptance Criteria

- File `e2e-isolate-b.txt` exists at the project root containing the text `isolate-b-ok`
- TypeScript compiles without errors
- Existing tests still pass
