---
depends: [verify-cli.md]
---

# MCP tool for forge verify

## Outcome

`forge_start` in `src/mcp.ts` accepts `'verify'` as a command, enabling Claude Code to trigger `forge verify` through the MCP server using the same async two-tool pattern (`forge_start` → `forge_task` / `forge_watch`). The `forge_start` tool description is updated to mention verify.

## Acceptance Criteria

- `forge_start` command enum in `src/mcp.ts` extended from `['define', 'prove', 'run', 'audit']` to `['define', 'prove', 'run', 'audit', 'verify']`
- When `command` is `'verify'`, the `spec_path` argument is passed as the positional `<proof-dir>` argument to the CLI
- `forge_start` tool description updated to mention verify alongside the other commands
- `--dry-run` can be passed via `extra_args: ["--dry-run"]`
- TypeScript compiles without errors
- Existing tests still pass
- MCP test file `src/mcp.test.ts` does NOT need updating (forge_start already tests the spawn pattern generically)

## Context

- `src/mcp.ts` — the `forge_start` tool handler already builds CLI args for each command; verify follows the same pattern as `audit`/`prove` (positional path arg + optional description)
- The child process inherits `stripClaudeEnv()` so the nested session guard is bypassed
- This is a minimal change — just extending the enum and adding a case for arg construction
