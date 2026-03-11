# Rename prove → proof throughout the codebase

## Outcome

The forge CLI exposes `forge proof` as the primary command for generating proofs. All internal references to "prove" are updated to "proof": file names, exported functions, TypeScript types, pipeline stage names, and documentation. A `forge prove` backward-compatible alias is preserved so existing scripts continue to work.

## Acceptance Criteria

- `forge proof <spec-path>` is the primary command (was `forge prove`); `forge prove <spec-path>` continues to work as a deprecated alias
- `src/prove.ts` is renamed to `src/proof.ts`; exported function `runProve` renamed to `runProof`; `ProveOptions` renamed to `ProofOptions` in `src/types.ts`; all imports updated across the codebase
- `ForgeResult.type` literal value `'prove'` renamed to `'proof'` in `src/types.ts`
- `StageName` union in `src/pipeline-types.ts` updated: `'prove'` → `'proof'`; `STAGE_ORDER` array updated; `GateKey` string literals updated (`'audit -> prove'` → `'audit -> proof'`, `'prove -> verify'` → `'proof -> verify'`)
- CLI `COMMANDS` set in `src/index.ts` and `--from`/`--gates` stage option values updated to accept `'proof'` instead of (or alongside) `'prove'`
- `skills/forge/SKILL.md` and `CLAUDE.md` updated: all `forge prove` examples and descriptions changed to `forge proof`
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/prove.ts` → rename file to `src/proof.ts`; rename export `runProve` → `runProof`
- `src/types.ts` — `ProveOptions` interface → `ProofOptions`; `ForgeResult.type` union literal `'prove'` → `'proof'`
- `src/index.ts` — command `prove` → `proof` (keep `prove` as alias); import from `./proof.js`; `COMMANDS` set; `--from`/`--gates` accepted stage values; `guardNestedSession` SDK command list
- `src/pipeline.ts` — import `runProof` from `./proof.js`; `case 'prove':` → `case 'proof':`; `runProve(...)` → `runProof(...)`
- `src/pipeline-types.ts` — `StageName`, `STAGE_ORDER`, `GateKey` union, `DEFAULT_GATES` key strings
- `src/pipeline-status.ts` — any stage display label referencing 'prove'
- `src/tui.tsx` — session type `'prove'` display label
- `src/parallel.ts` — `COMMANDS` set includes `'prove'`
- `src/mcp.ts` — any stage name string references in `forge_pipeline` or `forge_start` tools
- `skills/forge/SKILL.md` — `forge prove` command examples and description
- `CLAUDE.md` — command reference table, architecture description, file structure comments
- Pipeline state files (`.forge/pipeline.json`) are gitignored and ephemeral — existing states referencing stage name `"prove"` will be incompatible; this is acceptable
- Constraint: do not change the proof generation logic in `src/proof.ts` — this rename is purely mechanical
