# Writing Specs

Specs are markdown files that describe an outcome. The agent decides how to implement it.

## Template

```markdown
# <What this delivers>

## Outcome

<End state in 2-3 sentences. What exists when this is done?>

## Acceptance Criteria

- <Specific, verifiable condition>
- <Another condition>
- TypeScript compiles without errors
- Existing tests still pass

## Context

- <Relevant files: src/middleware/auth.ts>
- <Constraints: must use existing patterns in src/routes/>
- <Design decisions: use JWT, not sessions>
```

## Example

```markdown
# Add Rate Limiting to API

## Outcome

API endpoints are protected by rate limiting that prevents abuse while
allowing normal usage. Limits are configurable per-route.

## Acceptance Criteria

- Default limit: 100 requests per minute per IP
- Auth endpoints: 10 requests per minute per IP
- Rate-limited responses return 429 with Retry-After header
- Limits are configurable via environment variables
- TypeScript compiles without errors

## Context

- Express app in src/server.ts
- Route definitions in src/routes/
- Follow existing middleware patterns in src/middleware/
```

## Frontmatter

Optional YAML frontmatter for dependency graph and source tracking:

```yaml
---
depends: [database-schema.md, api-models.md]
source: github:vieko/forge#42
---
```

- **`depends:`** — List of spec filenames this spec depends on. Forge runs them in topological order: independent specs in parallel, dependent specs wait.
- **`source:`** — Origin tracking (optional). Used by `forge specs` display. Format: `github:owner/repo#issue` or any string.

## Conventions

**One concern per spec.** Each spec should be independently executable. Split large features into focused specs.

**Use `depends:` for ordering.** Declare dependencies explicitly in frontmatter. Forge builds a dependency graph and runs specs in topological levels — independent specs parallelize, dependent specs wait.

```
database-schema.md           # Level 1 (no deps, runs first)
api-models.md                # Level 1 (parallel with schema)
api-endpoints.md             # Level 2 (depends: [database-schema.md, api-models.md])
frontend-components.md       # Level 2 (depends: [api-models.md])
integration-tests.md         # Level 3 (depends: [api-endpoints.md, frontend-components.md])
```

**Number-prefix as fallback.** When not using `depends:`, number-prefix specs for alphabetical ordering. Use `--sequential-first N` to run foundations before parallelizing the rest.

**Point to relevant files.** The Context section saves the agent exploration time. List specific paths, not vague descriptions.

**Always include "TypeScript compiles" (or equivalent).** The agent uses acceptance criteria to self-check. Build/type errors are the most common failure mode.
