---
depends: [verify-pr-creation.md]
---

# CLI command registration for forge verify

## Outcome

`forge verify <proof-dir>` is registered as a command in `src/index.ts`, placed after the `prove` command. It accepts `--output-dir`, `--model`, `--cwd`, `--quiet`, and `--dry-run` options, applies the nested session guard, maps CLI flags to `VerifyOptions`, and delegates to `runVerify()`.

## Acceptance Criteria

- `forge verify <proof-dir>` command registered in `src/index.ts` using `program.command('verify')`, positioned after the `prove` command
- Options registered: `-o / --output-dir <path>`, `-m / --model <model>`, `-C / --cwd <path>`, `-q / --quiet`, `--dry-run`
- `guardNestedSession()` is the first call inside the action handler, before any async work
- CLI flags map correctly to `VerifyOptions` fields and are passed to `runVerify()`
- `forge verify --dry-run <proof-dir>` prints what would be verified and what PR would look like, then exits with code 0
- The command appears in `forge --help` with a concise description (e.g. `execute proof test protocols and create a PR`)
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/index.ts` — register `verify` using the `program.command('verify')` pattern; use the `prove` command registration as the direct template
- `src/proof-runner.ts` — exports `runVerify(options: VerifyOptions): Promise<void>` called by this action handler
- `src/types.ts` — `VerifyOptions` is the options interface; no `--resume` or `--fork` flags needed for this command
- `guardNestedSession()` is defined and used within `src/index.ts`; no import needed
- Banner is shown by `runVerify()` (not the CLI handler), consistent with how `runProve()` owns its own banner
- No `--max-turns` or `--max-budget` CLI flags are required (internal defaults in `runVerify()` are sufficient); only expose options listed in the description
