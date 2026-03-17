---
depends: [worktree-registry-schema.md]
---

# Sibling directory worktree creation with branch naming

## Outcome

Worktrees are created as sibling directories to the project root instead of in `/tmp/`. Branch names follow a deterministic convention. Every created worktree is registered in the `worktrees` DB table. The worktree path and branch are discoverable, editor-friendly, and visible in the filesystem.

## Acceptance Criteria

- Worktree directory created as sibling: `{project}-{linear_issue_id}-{spec_name}` when Linear issue present, `{project}-{spec_name}` otherwise (e.g., `~/dev/gtm-ENG-123-auth-login`)
- Branch naming: `forge/{issue-id}/{spec-name}` with Linear issue, `forge/{spec-name}` without (e.g., `forge/ENG-123/auth-login`)
- `createWorktree()` in `src/utils.ts` updated to accept a registry options object (spec_path, linear_issue_id, work_group_id) and use sibling path
- New worktree registered in `worktrees` table with status `created` on successful creation
- Spec name derived from spec filename (strip `.md`, replace non-alphanumeric with hyphens)
- Directory collision handling: if sibling directory already exists, append short suffix (e.g., `-2`)
- Branch collision handling: if `forge/{spec-name}` branch already exists (from a previous run or parallel work group), append work_group_id short suffix to branch name (e.g., `forge/auth-login-a3f2`). Check with `git rev-parse --verify` before creating
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/utils.ts` (createWorktree, commitWorktree, cleanupWorktree), `src/db.ts` (worktrees table CRUD)
- Current createWorktree uses `/tmp/forge-worktree-{sanitized-branch}` -- this changes to sibling directory pattern
- The project root is derived from the git repo root (`git rev-parse --show-toplevel`)
- Sibling directories are naturally visible in file explorers and `ls` output
- Linear issue ID is optional and comes from spec frontmatter `source: github:owner/repo#issue` or future Linear integration
- Branch collision is distinct from directory collision — both must be handled independently since reruns and parallel work groups can produce identical base names
- Current `createWorktree()` hard-fails on branch-already-checked-out (src/utils.ts:228,236,242); the new implementation must gracefully suffix instead of failing
