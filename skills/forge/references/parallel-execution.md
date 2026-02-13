# Parallel Execution

## Concurrency

Auto-detected: `freeMem / 2GB`, capped at `min(cpuCount, 5)`, floor 1.

```bash
# Auto (recommended)
forge run --spec-dir ./specs/ -P "task"

# Manual override
forge run --spec-dir ./specs/ -P --concurrency 3 "task"
```

Each agent session uses ~2GB memory. On a 16GB/8-core machine, expect concurrency of 3-4.

Reduce if you hit rate limits or memory pressure. Increase if you have headroom and many independent specs.

## Monitoring

```bash
# Live logs in separate terminal
forge watch

# Or auto-split tmux
forge run --spec-dir ./specs/ -P --watch "task"

# Batch results
forge status
```

## Cost

Parallel runs report per-spec and total cost:

```
────────────────────────────────────────────────────────
SPEC BATCH SUMMARY
────────────────────────────────────────────────────────
  ✓ 01-schema.md                    45.2s  $1.23
  ✓ 02-api.md                       62.1s  $1.87
  ✗ 03-ui.md                        38.5s  $0.95
  ✓ 04-tests.md                     51.3s  $1.45
────────────────────────────────────────────────────────
  Wall-clock: 68.4s
  Spec total: 197.1s
  Cost:       $5.50
  Result:     3/4 successful
```

Use `--dry-run` to estimate cost before committing to a full run.

## Key Behaviors

- Each spec runs in its own isolated agent session — no shared context.
- Verification (typecheck, build, test) runs independently per spec.
- Transient errors (rate limits, network) auto-retry with exponential backoff.
- Specs that write to the same files may conflict — use `--sequential-first` for dependencies.
- Results are grouped by batch run ID. Use `forge run --rerun-failed -P` to retry failures.
