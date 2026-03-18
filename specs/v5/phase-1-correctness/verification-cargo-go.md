---
---

# Verification runs tests for Rust and Go, and handles hybrid projects

## Outcome

Rust projects run `cargo test` in addition to `cargo check`/`cargo build`. Go projects run `go test ./...` in addition to `go build ./...`. Hybrid projects with both `package.json` and a `Cargo.toml` or `go.mod` verify all applicable runtimes independently.

## Acceptance Criteria

- `cargo test` runs after `cargo build` for Rust projects
- `go test ./...` runs after `go build ./...` for Go projects
- Detection of Cargo.toml and go.mod is independent of Node detection (not in an `else` branch)
- A project with both `package.json` and `Cargo.toml` runs both Node and Rust verification commands
- A project with both `package.json` and `go.mod` runs both Node and Go verification commands
- TypeScript compiles without errors
- Existing tests still pass

## Context

- `src/verify.ts` lines 359–457 — `detectVerification()` function
- `src/verify.ts` lines 393–402 — Rust and Go detection, currently in `else` branch after Node check at line 366
- Restructure so Rust and Go detection are independent checks, not mutually exclusive with Node
- Monorepo scoping for Cargo/Go is out of scope for this spec
