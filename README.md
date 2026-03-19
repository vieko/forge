# Forge

<p align="center"><img src="https://raw.githubusercontent.com/vieko/forge/main/forge.gif" alt="Forge" width="100%" /></p>

A verification boundary for autonomous agents. Define outcomes, not procedures.

One agent, one prompt, full autonomy. Forge doesn't tell the agent what to do — it verifies whether the outcome was met. Verification is external, objective, and automatic.

```bash
$ forge run --spec specs/power-ups.md "implement power-ups"
# 8 power-ups implemented, verification passed — $6.03, ~8 min
```

## Requirements

[Bun](https://bun.sh/) >= 1.2.0

```bash
curl -fsSL https://bun.sh/install | bash
```

## Installation

```bash
# From npm
bun install -g @vieko/forge

# From source
git clone https://github.com/vieko/forge.git
cd forge
bun install
bun run build
bun link          # Makes `forge` available globally
```

## Usage

```bash
forge run "implement feature X"                          # Run a task
forge run --spec specs/feature.md "implement this"       # From a spec file
forge run --spec-dir ./specs/ -P "implement these"       # Parallel specs
forge run --pending -P "implement pending"               # Run only pending specs
forge run --resume <session-id> "continue"               # Resume session
forge run --spec-dir ./specs/ --isolate "implement all"  # One worktree per spec
forge run --spec specs/feat.md --in-place "implement"   # Skip auto-worktree creation
```

```bash
forge define "build auth system"                         # Generate specs from description
forge audit specs/                                       # Audit codebase against specs
forge audit specs/ --fix                                 # Audit-fix convergence loop
forge proof specs/feature.md                             # Generate test protocols
forge verify .forge/proofs/                              # Run tests and create PR
forge pipeline "build auth system"                       # Full pipeline (define->run->audit->proof->verify)
forge tui                                                # Interactive TUI
forge review                                             # Review git changes
forge watch                                              # Live-tail session logs
forge status                                             # View recent results
forge stats                                              # Aggregate run statistics
forge specs                                              # List tracked specs with status
forge specs --add                                        # Register all untracked specs
forge specs --resolve game.md                            # Mark spec as passed
forge specs --check                                      # Auto-resolve implemented specs
```

See `forge --help` or `forge <command> --help` for all options.

## How It Works

1. **Prompt** — wraps your task in an outcome-focused template
2. **Agent** — single autonomous call, no orchestration
3. **Verify** — auto-detects project type, runs build/test, feeds errors back (up to 3 attempts)
4. **Save** — results, session logs, and cost to `.forge/results/`

Specs can declare dependencies via frontmatter (`depends: [a.md, b.md]`) for ordered execution. Parallel runs use auto-tuned concurrency. A manifest (`.forge/specs.json`) tracks every spec from registration through execution. Failed specs can be rerun. Pending specs can be run selectively. Manually completed specs can be resolved. Sessions can be resumed or forked. Destructive commands are blocked. Transient errors retry automatically.

## Operating Model

Forge is safest when treated in two modes:

- Authoring mode: `define`, `proof`, and similar spec-generation or planning flows can run against the current checkout state.
- Execution mode: `run --isolate` and dependency-level consolidation should be treated as committed-state validation.

Important implications for isolate runs:

- spawned worktrees are created from git refs (`HEAD` or consolidation branches), not from your uncommitted filesystem state
- if an isolate run depends on a Forge/runtime fix, commit that fix first
- after changing Forge runtime code, run `bun run build` and make sure MCP uses a fresh executor before trusting results

Long term, prefer mechanical verification over agent judgment:

- encode acceptance criteria in tests or verification commands where possible
- avoid relying on narrative \"this failure is unrelated\" pass decisions
- expect isolate and consolidation validation to prove required files and states directly

## Configuration

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Project-level overrides in `.forge/config.json`:

```json
{ "maxTurns": 100, "maxBudgetUsd": 10.00 }
```

## Works With

- [Bonfire](https://github.com/vieko/bonfire) — Session context persistence. Use `/bonfire spec` to create specs, then run them with Forge.

## Read More

- [The Orchestrator I Didn't Build](https://vieko.dev/outcomes)
- [Execution Best Practices](docs/execution-best-practices.md)
- [Testing Conventions](docs/testing-conventions.md)

## MCP Server

Forge exposes an MCP server for integration with Claude Code:

```bash
claude mcp add forge --scope user -t stdio -- bun /path/to/forge/dist/mcp.js
```

If you change Forge runtime code and use MCP/executor-backed commands:

1. commit the changes you need isolate worktrees to see
2. run `bun run build`
3. restart or replace any stale executor daemon
4. then start MCP `run --isolate` or consolidation validation

## Development

```bash
bun run src/index.ts run "test task"  # Dev mode
bun run typecheck                      # Type check
bun run build                          # Build
bun test                               # Run tests
```

## Credits

Animation by [Jon Romero Ruiz](https://x.com/jonroru).

## License

MIT
