# Fix index.ts Issues

## Outcome

The CLI entry point is more robust: the quick-alias check uses a Set instead of
a fragile string chain, and the SIGINT handler respects the `-C` working directory.

## Issues to Fix

### 1. Quick-alias command list is fragile (index.ts:251)

Current: a giant `&&` chain that must be updated for every new command:
```typescript
if (args[0] !== 'run' && args[0] !== 'status' && args[0] !== 'audit' && ...)
```

**Fix**: Use a Set of known commands:
```typescript
const COMMANDS = new Set(['run', 'status', 'audit', 'review', 'watch', 'help']);
if (args.length > 0 && !args[0].startsWith('-') && !COMMANDS.has(args[0])) {
```

Also remove the `--help`, `-h`, `--version`, `-V` checks — those start with `-`
and are already handled by `!args[0].startsWith('-')`.

### 2. SIGINT handler ignores -C flag (index.ts:259)

The handler reads `latest-session.json` from `process.cwd()`, but if `-C` was
used, the file is in the target repo directory. The resume/fork hints silently
fail to appear.

**Fix**: Parse `-C`/`--cwd` from `process.argv` before setting up the SIGINT
handler, and use that path if present. Keep `process.cwd()` as fallback.

## Acceptance Criteria

- Quick-alias uses a Set of known commands
- Adding a new command only requires adding to the Set (one place)
- SIGINT handler reads latest-session.json from the `-C` directory when provided
- `forge run -C ~/other-repo "task"` + Ctrl+C shows correct resume/fork hints
- TypeScript compiles without errors
- Existing tests still pass
