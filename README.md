# Forge

Minimal AI task orchestrator built on Anthropic's Agent SDK.

## The Problem

Complex features require multiple steps: reading code, planning tasks, implementing changes, reviewing work. Doing this manually with an AI assistant means constant back-and-forth.

## The Solution

Forge coordinates three specialized agents—planner, worker, reviewer—that handle the full cycle autonomously. Give it a spec, get back working code.

```
~300 lines total

User Prompt + Spec
        ↓
   Agent SDK query()
        ↓
┌────────────────────────────────────┐
│  Planner → Worker → Reviewer       │
│     ↓         ↓          ↓         │
│  TaskCreate  Edit    TaskCreate    │
│  TaskUpdate  Write   (fixes)       │
└────────────────────────────────────┘
        ↓
   Working Code
```

## Real Example

```bash
# Run 10 feature specs on a game project
$ forge run -C ~/dev/arkanoid-game --spec specs/power-ups.md "implement power-ups"

# Result: 8 power-ups implemented, tests passing, reviewer approved
# Cost: $6.03 | Time: ~8 min
```

## Installation

```bash
git clone https://github.com/vieko/forge.git
cd forge
bun install
bun run build
```

## Usage

```bash
# Run a task
forge run "implement feature X"

# With spec file (recommended)
forge run --spec .bonfire/specs/feature.md "implement this"

# Target different directory
forge run -C ~/other-repo "add tests"

# Resume interrupted session
forge run --resume <session-id>

# Plan only (no implementation)
forge run --plan-only "design API for Y"
```

## Agent Roles

| Agent | Purpose | Tools |
|-------|---------|-------|
| **Planner** | Reads spec, decomposes into tasks | Read, Grep, Glob, TaskCreate, TaskUpdate, TaskList |
| **Worker** | Implements each task | Read, Write, Edit, Bash, Grep, Glob, TaskGet, TaskUpdate, TaskList |
| **Reviewer** | Reviews work, creates fix tasks | Read, Grep, Glob, Bash, TaskCreate, TaskUpdate, TaskList, TaskGet |

## Configuration

```bash
# Option 1: Direct API key
export ANTHROPIC_API_KEY=sk-ant-...

# Option 2: Vercel AI Gateway
export VERCEL_AI_GATEWAY_URL=https://...
export VERCEL_AI_GATEWAY_KEY=vck_...
```

## Works With

- [Bonfire](https://github.com/vieko/bonfire) - Session context persistence. Use `/bonfire spec` to create specs, then run them with Forge.

## Development

```bash
bun run src/index.ts run "test task"  # Dev mode
bun run typecheck                      # Type check
bun run build                          # Build
```

## Design

Forge follows patterns from [ctate's "How to Get Out of Your Agent's Way"](https://ctate.dev/posts/how-to-get-out-of-your-agents-way)—define outcomes, let agents determine procedures.

## License

MIT
