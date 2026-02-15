# Forge

<p align="center"><img src="https://raw.githubusercontent.com/vieko/forge/main/forge.gif" alt="Forge" width="100%" /></p>

A verification boundary for autonomous agents. Define outcomes, not procedures.

One agent, one prompt, full autonomy. Forge doesn't tell the agent what to do — it verifies whether the outcome was met. Verification is external, objective, and automatic.

```bash
$ forge run --spec specs/power-ups.md "implement power-ups"
# 8 power-ups implemented, verification passed — $6.03, ~8 min
```

## Installation

```bash
# From npm
npm install -g @vieko/forge

# From source
git clone https://github.com/vieko/forge.git
cd forge
bun install
bun run build
```

## Usage

```bash
forge run "implement feature X"                          # Run a task
forge run --spec specs/feature.md "implement this"       # From a spec file
forge run --spec-dir ./specs/ -P "implement these"       # Parallel specs
forge run --resume <session-id> "continue"               # Resume session
```

```bash
forge audit specs/                                       # Audit codebase against specs
forge review                                             # Review git changes
forge watch                                              # Live-tail session logs
forge status                                             # View recent results
forge specs                                              # List tracked specs with status
```

See `forge --help` or `forge <command> --help` for all options.

## How It Works

1. **Prompt** — wraps your task in an outcome-focused template
2. **Agent** — single autonomous call, no orchestration
3. **Verify** — auto-detects project type, runs build/test, feeds errors back (up to 3 attempts)
4. **Save** — results, session logs, and cost to `.forge/results/`

Specs can declare dependencies via frontmatter (`depends: [a.md, b.md]`) for ordered execution. Parallel runs use auto-tuned concurrency. A manifest (`.forge/specs.json`) tracks every spec from registration through execution. Failed specs can be rerun. Sessions can be resumed or forked. Destructive commands are blocked. Transient errors retry automatically.

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
