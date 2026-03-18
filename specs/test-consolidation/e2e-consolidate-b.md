# E2E: Consolidation producer B

## Outcome

A second level-1 isolated spec creates its own marker file in parallel with producer A so both changes must be consolidated before the dependent spec runs.

## Acceptance Criteria

- File `e2e-consolidate-b.txt` exists at the project root containing the text `consolidate-b-ok`
- TypeScript compiles without errors
- Existing tests still pass
