---
---

# Bun Runtime Migration

## Outcome

Forge explicitly requires Bun as its runtime. Shebangs, `package.json` engine field, bin entry, MCP server entry point, and build pipeline all reflect Bun as the platform. The current Node-first contract is replaced — Bun is required, not optional.

## Acceptance Criteria

- `#!/usr/bin/env bun` shebang on `src/index.ts` and `src/mcp.ts` (replaces `#!/usr/bin/env node`)
- `package.json` engines field updated: `"bun": ">=1.2.0"` (remove `"node": ">=20.0.0"`)
- `bin` entry points to compiled output that runs under Bun
- MCP server entry point updated: `dist/mcp.js` runs under Bun (Claude Code MCP config changes from `node` to `bun`)
- TUI bun re-exec hack removed from `src/index.ts` (~line 544-557) — no longer needed when entire CLI runs under Bun
- `bun build` produces output compatible with Bun runtime (no Node polyfills needed)
- README documents Bun as a requirement with install instructions
- TypeScript compiles without errors
- Existing tests still pass under `bun test`

## Context

- Relevant files: `src/index.ts` (shebang at line 1, TUI re-exec at ~line 544), `src/mcp.ts` (shebang at line 1), `package.json` (engines, bin)
- The TUI already requires Bun (OpenTUI imports `.scm` files). The current workaround at line 544-557 re-execs under Bun when running from Node — this entire escape hatch becomes unnecessary
- Development toolchain is already 100% Bun: `bun run`, `bun link`, `bun run dev`, `bun run build`, `bun test`
- MCP config is global: `claude mcp add forge --scope user -t stdio -- bun /path/to/dist/mcp.js`. Users must update their config after this change
- `bun build --compile` (single-file executable, no runtime dependency) is a future option this unlocks but is NOT part of this spec
- This spec is the gate for `bun:sqlite` (db-core.md) and `Bun.serve` (http-api.md)
