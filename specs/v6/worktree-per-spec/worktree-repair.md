---
depends: [cli-worktree-commands.md]
---

# Worktree repair command for corrupted or orphaned worktrees

## Outcome

`forge worktree repair` detects and fixes common worktree problems: orphaned git worktrees (directory exists but git tracking lost), registry/filesystem mismatches (DB says worktree exists but directory is gone, or vice versa), and corrupted git state. Repair is non-destructive by default.

## Acceptance Criteria

- `forge worktree repair` scans all worktree registry entries and checks filesystem + git state consistency
- Detects orphaned directories: sibling directories matching forge naming pattern but not in the registry → offers to register or remove
- Detects missing directories: registry entry exists but worktree directory is gone → marks status as `failed` with error, or removes entry with `--clean` flag
- Detects git worktree deregister: directory exists but `git worktree list` doesn't include it → recovery strategy: (1) check if the branch still exists in the main repo, (2) if yes, rename the orphaned directory to `{path}.bak`, (3) create a fresh worktree at the original path from the existing branch (`git worktree add {path} {branch}`), (4) overwrite the fresh checkout with the full contents of the backup directory (`rsync -a --exclude=.git {path}.bak/ {path}/`), preserving all tracked-but-modified files, untracked files, and local changes, (5) remove the backup. If the branch no longer exists, log a warning and skip (manual intervention needed)
- Detects stale locks: `.git/worktrees/<name>/locked` files from crashed processes → removes lock with `git worktree unlock`
- `--dry-run` flag shows what would be repaired without taking action (default)
- `--fix` flag applies the repairs
- Summary output: N worktrees checked, N issues found, N fixed
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/utils.ts` (worktree git operations), `src/db.ts` (worktrees table), `src/index.ts` (CLI registration)
- Common corruption scenarios: process killed mid-creation, manual directory deletion, git gc aggressive, OS /tmp cleanup (if any legacy worktrees remain there)
- Deregister recovery uses `git worktree add` (the only safe way to create a valid worktree) by temporarily moving the orphaned directory aside. This avoids reconstructing git internal files manually, which is brittle and version-dependent
- The full working tree contents (minus `.git`) are restored from the backup via rsync overlay. This preserves untracked files and tracked-but-modified files. Previously staged changes will appear as unstaged modifications (the git index is inside `.git` and cannot be safely transplanted to the fresh worktree). The fresh `git worktree add` provides a valid `.git` link; the rsync provides the user's actual file contents. After restore, `git status` in the repaired worktree will show modifications but staging state is lost
- If the branch no longer exists (deleted or garbage collected), repair logs a warning and skips — the user must manually decide whether to recreate the branch or discard the worktree
- Repair is idempotent — running it multiple times produces the same result
- Sibling directory naming pattern (`{project}-*`) is used to discover orphaned worktrees; the project name is derived from the git repo directory name
- Non-destructive by default: `--dry-run` is the default, `--fix` is opt-in
