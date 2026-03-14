---
depends: []
---

# Manifest-Aware Dependency Resolution

The dep resolver should treat already-passed specs in the manifest as satisfied dependencies, not require them in the current batch. This unblocks remediation specs that depend on parent specs from prior runs.

## Problem

`validateDeps()` in `src/deps.ts` requires every `depends:` reference to exist in the current spec batch. When running a subset (e.g., `--spec-dir specs/foo/remediation/`), specs that depend on already-implemented parent specs fail with:

```
Error: Unresolved spec dependencies:
  r2-feature.md depends on "parent-feature.md" which is not in the spec batch
```

This blocks the common workflow: run specs → audit → fix remediation → remediation specs depend on the originals that already passed.

## Acceptance Criteria

1. **`validateDeps()` accepts a manifest parameter**: `validateDeps(specs: SpecDep[], manifest?: SpecManifest)`. When provided, a dependency is considered satisfied if it matches a spec with status `passed` in the manifest.

2. **Match by filename**: Dependencies are matched by filename (e.g., `index-google-calendar.md`). A manifest entry with spec path `specs/index-extension/index-google-calendar.md` satisfies a dependency on `index-google-calendar.md`.

3. **Only passed specs satisfy deps**: Specs with status `pending`, `running`, or `failed` in the manifest do NOT satisfy dependencies. Only `passed` counts.

4. **Callers pass manifest**: `topoSort()` and the parallel runner in `src/parallel.ts` pass the loaded manifest to `validateDeps()` when available. The manifest is already loaded at that point for skip-passed logic.

5. **No manifest = current behavior**: When no manifest is provided (standalone runs, tests), validation behaves exactly as today — all deps must be in the batch.

6. **Satisfied deps excluded from topo levels**: A spec whose only dependencies are manifest-satisfied has no in-batch deps — it goes in level 0 (runs immediately). A spec with mixed deps (some in-batch, some manifest-satisfied) only waits for the in-batch ones.

7. **Warning on non-passed manifest dep**: If a dependency exists in the manifest but is not `passed` (e.g., `pending` or `failed`), emit a warning: `"r2-feature.md depends on parent-feature.md (status: failed in manifest) — may not be satisfied"`. Don't block, just warn.

## Tests

8. **Unit tests**: Cover all cases — dep satisfied by manifest, dep not in manifest or batch (error), dep in manifest but failed (warning), mixed in-batch and manifest deps, no manifest fallback.

## Out of Scope

- Cross-directory dep resolution (deps still match by filename only)
- Automatic dep installation or re-running of failed deps
- Changing `depends:` frontmatter format

## Key Files

- `src/deps.ts` — `validateDeps()`, `topoSort()`: add optional manifest parameter
- `src/parallel.ts` — pass manifest to dep validation
- `src/specs.ts` — `loadManifest()` already exists, just needs to be threaded through
