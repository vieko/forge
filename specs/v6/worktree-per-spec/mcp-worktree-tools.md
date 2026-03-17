---
depends: [worktree-registry-schema.md, worktree-persistent-lifecycle.md]
---

# MCP tools for worktree operations

## Outcome

The MCP server exposes new tools for listing and managing worktrees, and existing tools accept worktree context. Claude Code users can discover worktrees, scope operations to specific worktrees, and monitor worktree-isolated work through the MCP interface.

## Acceptance Criteria

- New `forge_worktrees` MCP tool: lists worktrees with status, spec, branch, path; supports filter by `work_group_id` and `status`
- `forge_start` accepts optional `worktree_id` parameter to run inside an existing worktree
- `forge_start` accepts optional `isolate` boolean to trigger worktree-per-spec mode
- `forge_task` response enriched with `worktree_id`, `worktree_path`, and `worktree_status` when task is associated with a worktree
- `forge_watch` accepts optional `worktree_id` parameter for scoped log following
- All new parameters documented in tool descriptions
- TypeScript compiles without errors
- Existing tests still pass

## Context

- Relevant files: `src/mcp.ts` (MCP server, tool definitions, forge_start, forge_task, forge_watch), `src/db.ts` (worktrees table CRUD)
- Follow existing MCP tool patterns: Zod schema for params, structured JSON response
- `forge_worktrees` is a fast tool (no SDK call, reads DB directly) like `forge_specs` and `forge_status`
- The `worktree_id` on `forge_start` tells the executor to run inside that worktree instead of creating a new one
