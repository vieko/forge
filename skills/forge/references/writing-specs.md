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

## Conventions

**One concern per spec.** Each spec should be independently executable. Split large features:

```
01-database-schema.md
02-api-endpoints.md
03-frontend-components.md
04-integration-tests.md
```

**Number-prefix for ordering.** Specs sort alphabetically. Use `--sequential-first N` to run foundations before parallelizing the rest.

**Point to relevant files.** The Context section saves the agent exploration time. List specific paths, not vague descriptions.

**Always include "TypeScript compiles" (or equivalent).** The agent uses acceptance criteria to self-check. Build/type errors are the most common failure mode.
