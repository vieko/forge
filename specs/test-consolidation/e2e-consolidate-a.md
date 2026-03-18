# E2E: Consolidation producer A

## Outcome

A level-1 isolated spec creates its own marker file so its change can be consolidated forward to a dependent spec.

## Acceptance Criteria

- File `e2e-consolidate-a.txt` exists at the project root containing the text `consolidate-a-ok`
- TypeScript compiles without errors
- Existing tests still pass
