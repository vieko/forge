---
depends: [e2e-consolidate-a.md, e2e-consolidate-b.md]
---

# E2E: Consolidation dependent

## Outcome

A dependent isolated spec proves it started from the consolidated result of both producer specs, not from main and not from only one parent branch.

## Acceptance Criteria

- Before creating any new files for this spec, both `e2e-consolidate-a.txt` and `e2e-consolidate-b.txt` already exist at the project root
- `e2e-consolidate-a.txt` contains `consolidate-a-ok`
- `e2e-consolidate-b.txt` contains `consolidate-b-ok`
- Do not create or modify `e2e-consolidate-a.txt` or `e2e-consolidate-b.txt` in this spec; they must come from the consolidated parent state
- File `e2e-consolidate-dependent.txt` exists at the project root containing the text `consolidate-dependent-ok`
- TypeScript compiles without errors
- Existing tests still pass
