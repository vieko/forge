import { describe, test, expect } from 'bun:test';
import { assessSpecComplexity } from './specs.js';

// ── assessSpecComplexity ─────────────────────────────────────

describe('assessSpecComplexity', () => {
  test('returns null for a spec within all thresholds', () => {
    const content = `# Small Feature

## Outcome

A small feature is implemented.

## Acceptance Criteria

- First criterion
- Second criterion
- Third criterion
- TypeScript compiles without errors

## Context

- src/index.ts
`;
    expect(assessSpecComplexity('small.md', content)).toBeNull();
  });

  test('warns when acceptance criteria exceed threshold', () => {
    const criteria = Array.from({ length: 10 }, (_, i) => `- Criterion ${i + 1}`).join('\n');
    const content = `# Big Feature

## Outcome

A big feature.

## Acceptance Criteria

${criteria}

## Context

- src/index.ts
`;
    const result = assessSpecComplexity('big.md', content);
    expect(result).not.toBeNull();
    expect(result!.file).toBe('big.md');
    expect(result!.criteria).toBe(10);
    expect(result!.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('10 acceptance criteria')]),
    );
  });

  test('warns when word count exceeds threshold', () => {
    // Generate a spec body with > 500 words
    const filler = Array.from({ length: 120 }, (_, i) => `Word${i}`).join(' ');
    const content = `# Wordy Feature

## Outcome

${filler} ${filler} ${filler} ${filler} ${filler}

## Acceptance Criteria

- One criterion
- Two criterion

## Context

- src/index.ts
`;
    const result = assessSpecComplexity('wordy.md', content);
    expect(result).not.toBeNull();
    expect(result!.words).toBeGreaterThan(500);
    expect(result!.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('words')]),
    );
  });

  test('warns when H2 sections exceed threshold', () => {
    const content = `# Many Sections

## Outcome

Something.

## Acceptance Criteria

- One criterion

## Context

- src/index.ts

## Design

Details.

## Migration

Steps.

## Testing

Plan.

## Rollback

Plan.
`;
    const result = assessSpecComplexity('sections.md', content);
    expect(result).not.toBeNull();
    expect(result!.sections).toBe(7);
    expect(result!.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('7 sections')]),
    );
  });

  test('excludes frontmatter from word count', () => {
    const content = `---
depends: [other.md]
source: github:org/repo#42
some_long_field: ${'word '.repeat(200)}
---

# Small

## Outcome

Short.

## Acceptance Criteria

- Done
`;
    const result = assessSpecComplexity('frontmatter.md', content);
    // Frontmatter words should not push this over the 500-word limit
    expect(result).toBeNull();
  });

  test('returns null when no acceptance criteria header exists (fallback to other checks)', () => {
    const content = `# No AC Header

## Outcome

A feature without acceptance criteria header.

## Context

- src/index.ts
`;
    // Under word/section thresholds, no AC header means 0 criteria counted
    expect(assessSpecComplexity('no-ac.md', content)).toBeNull();
  });

  test('exactly at threshold returns null (boundary)', () => {
    const criteria = Array.from({ length: 8 }, (_, i) => `- Criterion ${i + 1}`).join('\n');
    const content = `# Boundary

## Outcome

Boundary test.

## Acceptance Criteria

${criteria}

## Context

- src/index.ts
`;
    expect(assessSpecComplexity('boundary.md', content)).toBeNull();
  });

  test('multiple reasons are collected', () => {
    const criteria = Array.from({ length: 12 }, (_, i) => `- Criterion ${i + 1}`).join('\n');
    const filler = Array.from({ length: 120 }, (_, i) => `Word${i}`).join(' ');
    const content = `# Everything Over

## Outcome

${filler} ${filler} ${filler} ${filler} ${filler}

## Acceptance Criteria

${criteria}

## Design

Details.

## Migration

Steps.

## Testing

Plan.

## Rollback

Plan.

## Monitoring

Plan.

## Context

- src/index.ts
`;
    const result = assessSpecComplexity('everything.md', content);
    expect(result).not.toBeNull();
    expect(result!.reasons.length).toBeGreaterThanOrEqual(2);
  });

  test('handles indented acceptance criteria lines', () => {
    const criteria = Array.from({ length: 10 }, (_, i) => `  - Criterion ${i + 1}`).join('\n');
    const content = `# Indented

## Outcome

Indented criteria.

## Acceptance Criteria

${criteria}

## Context

- src/index.ts
`;
    const result = assessSpecComplexity('indented.md', content);
    expect(result).not.toBeNull();
    expect(result!.criteria).toBe(10);
  });
});
