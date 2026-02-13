# Minor Code Cleanups

## Outcome

Small inconsistencies and inefficiencies are cleaned up without changing behavior.

## Items

### 1. Move SPINNER_FRAMES near display constants (query.ts:1009)

`SPINNER_FRAMES` is defined ~900 lines after its first use in `createInlineSpinner` (line 96).
Move it up next to `AGENT_VERBS` and the other display constants.

### 2. Fix confusing desc.substring(2) (query.ts:539)

```typescript
const desc = description ? `: ${description}` : '';
agentSpinner.update(`${CMD}${verb}...${RESET}  ${desc.substring(2)}`);
```

Constructs `: description` then strips the `: `. Replace with:
```typescript
agentSpinner.update(`${CMD}${verb}...${RESET}  ${description || ''}`);
```

### 3. Normalize ANSI escape case

Mix of `\x1b` (lowercase, in constants) and `\x1B` (uppercase, inline).
Standardize to lowercase `\x1b` everywhere.

### 4. Cache audit log mkdir (query.ts:387)

`await fs.mkdir(path.join(workingDir, '.forge'), { recursive: true })` runs on
every PostToolUse hook. Add a `forgeDirCreated` boolean and skip after first call.

### 5. Single-pass findFailedSpecs (query.ts:1244-1272)

Currently reads all results twice: first to find the latest runId, then to collect
failures. Combine into one pass: read all summaries, find the latest runId from
the first result with a runId, then filter failures from the same collection.

### 6. Remove dead fallback code (query.ts:557-586)

The `progressMode === 'spinner' && !agentSpinner` branch handles "spinner not yet
started." But the spinner is always created in the init handler, and init always
precedes stream events. This 30-line block is unreachable. Remove it.

## Acceptance Criteria

- All 6 items addressed
- No behavioral changes
- TypeScript compiles without errors
- Existing tests still pass
