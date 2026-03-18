import { describe, test, expect } from 'bun:test';
import { parseDependencies, parseSource, parseScope, topoSort, detectCycle, validateDeps, hasDependencies, type SpecDep } from './deps.js';
import type { SpecManifest } from './types.js';

// ── parseDependencies ───────────────────────────────────────

describe('parseDependencies', () => {
  test('returns empty array for no frontmatter', () => {
    expect(parseDependencies('# Just a heading\nSome content')).toEqual([]);
  });

  test('returns empty array for frontmatter without depends', () => {
    const content = `---
title: My Spec
---

# Content`;
    expect(parseDependencies(content)).toEqual([]);
  });

  test('parses inline array syntax', () => {
    const content = `---
depends: [01-database.md, 02-models.md]
---

# Implement endpoints`;
    expect(parseDependencies(content)).toEqual(['01-database.md', '02-models.md']);
  });

  test('parses inline array with extra spaces', () => {
    const content = `---
depends: [ 01-database.md ,  02-models.md ]
---

# Implement endpoints`;
    expect(parseDependencies(content)).toEqual(['01-database.md', '02-models.md']);
  });

  test('parses block array syntax', () => {
    const content = `---
depends:
  - 01-database.md
  - 02-models.md
---

# Implement endpoints`;
    expect(parseDependencies(content)).toEqual(['01-database.md', '02-models.md']);
  });

  test('parses single dependency in inline array', () => {
    const content = `---
depends: [01-database.md]
---

# Content`;
    expect(parseDependencies(content)).toEqual(['01-database.md']);
  });

  test('parses single dependency in block array', () => {
    const content = `---
depends:
  - 01-database.md
---

# Content`;
    expect(parseDependencies(content)).toEqual(['01-database.md']);
  });

  test('returns empty array for empty inline array', () => {
    const content = `---
depends: []
---

# Content`;
    expect(parseDependencies(content)).toEqual([]);
  });

  test('ignores content that looks like frontmatter but is not at start', () => {
    const content = `Some text
---
depends: [01-foo.md]
---`;
    expect(parseDependencies(content)).toEqual([]);
  });

  test('handles frontmatter with other fields', () => {
    const content = `---
title: My Spec
depends: [01-database.md]
priority: high
---

# Content`;
    expect(parseDependencies(content)).toEqual(['01-database.md']);
  });
});

// ── parseDependencies (markdown fallback) ────────────────────

describe('parseDependencies (markdown fallback)', () => {
  test('parses **Depends on**: with single link', () => {
    const content = `# My Spec

**Depends on**: [Schema](./01-schema.md)
**Status**: Ready`;
    expect(parseDependencies(content)).toEqual(['01-schema.md']);
  });

  test('parses **Depends on**: with multiple links', () => {
    const content = `# My Spec

**Depends on**: [Schema](./01-schema.md), [Models](./02-models.md)
**Status**: Ready`;
    expect(parseDependencies(content)).toEqual(['01-schema.md', '02-models.md']);
  });

  test('extracts basename from nested paths', () => {
    const content = `# Spec

**Depends on**: [Base](../shared/01-base.md)`;
    expect(parseDependencies(content)).toEqual(['01-base.md']);
  });

  test('YAML frontmatter takes precedence over markdown', () => {
    const content = `---
depends: [from-frontmatter.md]
---

# Spec

**Depends on**: [Other](./from-markdown.md)`;
    expect(parseDependencies(content)).toEqual(['from-frontmatter.md']);
  });

  test('handles **Dependencies**: variant', () => {
    const content = `# Spec

**Dependencies**: [Schema](./01-schema.md)`;
    expect(parseDependencies(content)).toEqual(['01-schema.md']);
  });

  test('returns empty for no dependency declaration', () => {
    const content = `# Spec

Just some content with no deps.`;
    expect(parseDependencies(content)).toEqual([]);
  });

  test('handles **Depend**: variant', () => {
    const content = `# Spec

**Depend on**: [Schema](./01-schema.md)`;
    expect(parseDependencies(content)).toEqual(['01-schema.md']);
  });
});

// ── parseSource ──────────────────────────────────────────────

describe('parseSource', () => {
  test('no frontmatter → returns undefined', () => {
    expect(parseSource('# Just a heading\nSome content')).toBeUndefined();
  });

  test('frontmatter without source field → returns undefined', () => {
    const content = `---
title: My Spec
depends: [01-foo.md]
---

# Content`;
    expect(parseSource(content)).toBeUndefined();
  });

  test('source: github:vieko/forge#42 → returns "github:vieko/forge#42"', () => {
    const content = `---
source: github:vieko/forge#42
---

# Content`;
    expect(parseSource(content)).toBe('github:vieko/forge#42');
  });

  test('source: file → returns "file"', () => {
    const content = `---
source: file
---

# Content`;
    expect(parseSource(content)).toBe('file');
  });

  test('source field with extra whitespace → trimmed correctly', () => {
    const content = `---
source:   github:vieko/forge#99
---

# Content`;
    expect(parseSource(content)).toBe('github:vieko/forge#99');
  });
});

// ── parseScope ──────────────────────────────────────────────

describe('parseScope', () => {
  test('no frontmatter -> returns undefined', () => {
    expect(parseScope('# Just a heading\nSome content')).toBeUndefined();
  });

  test('frontmatter without scope field -> returns undefined', () => {
    const content = `---
title: My Spec
depends: [01-foo.md]
---

# Content`;
    expect(parseScope(content)).toBeUndefined();
  });

  test('scope: packages/api -> returns "packages/api"', () => {
    const content = `---
scope: packages/api
---

# Content`;
    expect(parseScope(content)).toBe('packages/api');
  });

  test('scope: apps/web -> returns "apps/web"', () => {
    const content = `---
scope: apps/web
---

# Content`;
    expect(parseScope(content)).toBe('apps/web');
  });

  test('scope with extra whitespace -> trimmed correctly', () => {
    const content = `---
scope:   packages/api
---

# Content`;
    expect(parseScope(content)).toBe('packages/api');
  });

  test('scope with leading slash -> stripped', () => {
    const content = `---
scope: /packages/api
---

# Content`;
    expect(parseScope(content)).toBe('packages/api');
  });

  test('scope with trailing slash -> stripped', () => {
    const content = `---
scope: packages/api/
---

# Content`;
    expect(parseScope(content)).toBe('packages/api');
  });

  test('scope alongside other frontmatter fields', () => {
    const content = `---
depends: [01-base.md]
scope: packages/api
source: github:vieko/forge#42
---

# Content`;
    expect(parseScope(content)).toBe('packages/api');
  });

  test('scope in body (not frontmatter) -> returns undefined', () => {
    const content = `# Spec

scope: packages/api`;
    expect(parseScope(content)).toBeUndefined();
  });

  test('single directory scope -> returns as-is', () => {
    const content = `---
scope: api
---

# Content`;
    expect(parseScope(content)).toBe('api');
  });
});

// ── hasDependencies ─────────────────────────────────────────

describe('hasDependencies', () => {
  test('returns false when no specs have dependencies', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'b.md', path: '/b.md', depends: [] },
    ];
    expect(hasDependencies(specs)).toBe(false);
  });

  test('returns true when at least one spec has dependencies', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
    ];
    expect(hasDependencies(specs)).toBe(true);
  });
});

// ── validateDeps ────────────────────────────────────────────

describe('validateDeps', () => {
  test('passes for valid dependencies', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
    ];
    expect(() => validateDeps(specs)).not.toThrow();
  });

  test('throws for missing dependency', () => {
    const specs: SpecDep[] = [
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
    ];
    expect(() => validateDeps(specs)).toThrow('Unresolved spec dependencies');
    expect(() => validateDeps(specs)).toThrow('b.md depends on "a.md"');
  });

  test('throws for multiple missing dependencies', () => {
    const specs: SpecDep[] = [
      { name: 'c.md', path: '/c.md', depends: ['a.md', 'b.md'] },
    ];
    expect(() => validateDeps(specs)).toThrow('Unresolved spec dependencies');
  });
});

// ── detectCycle ──────────────────────────────────────────────

describe('detectCycle', () => {
  test('returns null for acyclic graph', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
      { name: 'c.md', path: '/c.md', depends: ['b.md'] },
    ];
    expect(detectCycle(specs)).toBeNull();
  });

  test('detects simple cycle (a → b → a)', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: ['b.md'] },
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
    ];
    const cycle = detectCycle(specs);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
  });

  test('detects three-way cycle (a → b → c → a)', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: ['b.md'] },
      { name: 'b.md', path: '/b.md', depends: ['c.md'] },
      { name: 'c.md', path: '/c.md', depends: ['a.md'] },
    ];
    const cycle = detectCycle(specs);
    expect(cycle).not.toBeNull();
  });

  test('returns null for no dependencies', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'b.md', path: '/b.md', depends: [] },
    ];
    expect(detectCycle(specs)).toBeNull();
  });

  test('detects self-dependency', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: ['a.md'] },
    ];
    const cycle = detectCycle(specs);
    expect(cycle).not.toBeNull();
  });
});

// ── topoSort ────────────────────────────────────────────────

describe('topoSort', () => {
  test('all independent specs → single level', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'b.md', path: '/b.md', depends: [] },
      { name: 'c.md', path: '/c.md', depends: [] },
    ];
    const levels = topoSort(specs);
    expect(levels).toHaveLength(1);
    expect(levels[0].specs.map(s => s.name)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  test('linear chain → one spec per level', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
      { name: 'c.md', path: '/c.md', depends: ['b.md'] },
    ];
    const levels = topoSort(specs);
    expect(levels).toHaveLength(3);
    expect(levels[0].specs.map(s => s.name)).toEqual(['a.md']);
    expect(levels[1].specs.map(s => s.name)).toEqual(['b.md']);
    expect(levels[2].specs.map(s => s.name)).toEqual(['c.md']);
  });

  test('diamond dependency → correct levels', () => {
    // a → b, a → c, b → d, c → d
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
      { name: 'c.md', path: '/c.md', depends: ['a.md'] },
      { name: 'd.md', path: '/d.md', depends: ['b.md', 'c.md'] },
    ];
    const levels = topoSort(specs);
    expect(levels).toHaveLength(3);
    expect(levels[0].specs.map(s => s.name)).toEqual(['a.md']);
    expect(levels[1].specs.map(s => s.name).sort()).toEqual(['b.md', 'c.md']);
    expect(levels[2].specs.map(s => s.name)).toEqual(['d.md']);
  });

  test('mixed: some with deps, some without', () => {
    const specs: SpecDep[] = [
      { name: 'independent.md', path: '/i.md', depends: [] },
      { name: 'base.md', path: '/b.md', depends: [] },
      { name: 'dependent.md', path: '/d.md', depends: ['base.md'] },
    ];
    const levels = topoSort(specs);
    expect(levels).toHaveLength(2);
    // First level has both independent specs
    expect(levels[0].specs.map(s => s.name)).toEqual(['base.md', 'independent.md']);
    expect(levels[1].specs.map(s => s.name)).toEqual(['dependent.md']);
  });

  test('throws on cycle', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: ['b.md'] },
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
    ];
    expect(() => topoSort(specs)).toThrow('Circular dependency detected');
  });

  test('throws on missing dependency', () => {
    const specs: SpecDep[] = [
      { name: 'b.md', path: '/b.md', depends: ['nonexistent.md'] },
    ];
    expect(() => topoSort(specs)).toThrow('Unresolved spec dependencies');
  });

  test('specs within a level are sorted alphabetically', () => {
    const specs: SpecDep[] = [
      { name: 'z-spec.md', path: '/z.md', depends: [] },
      { name: 'a-spec.md', path: '/a.md', depends: [] },
      { name: 'm-spec.md', path: '/m.md', depends: [] },
    ];
    const levels = topoSort(specs);
    expect(levels[0].specs.map(s => s.name)).toEqual(['a-spec.md', 'm-spec.md', 'z-spec.md']);
  });

  test('complex graph with multiple roots and shared deps', () => {
    // Two independent roots, shared middle layer, single sink
    const specs: SpecDep[] = [
      { name: '01-db.md', path: '/1.md', depends: [] },
      { name: '02-auth.md', path: '/2.md', depends: [] },
      { name: '03-models.md', path: '/3.md', depends: ['01-db.md'] },
      { name: '04-middleware.md', path: '/4.md', depends: ['02-auth.md'] },
      { name: '05-api.md', path: '/5.md', depends: ['03-models.md', '04-middleware.md'] },
    ];
    const levels = topoSort(specs);
    expect(levels).toHaveLength(3);
    expect(levels[0].specs.map(s => s.name)).toEqual(['01-db.md', '02-auth.md']);
    expect(levels[1].specs.map(s => s.name)).toEqual(['03-models.md', '04-middleware.md']);
    expect(levels[2].specs.map(s => s.name)).toEqual(['05-api.md']);
  });
});

// ── validateDeps (manifest-aware) ────────────────────────────

function makeManifest(entries: Array<{ spec: string; status: string }>): SpecManifest {
  return {
    version: 1,
    specs: entries.map(e => ({
      spec: e.spec,
      status: e.status as 'pending' | 'running' | 'passed' | 'failed',
      runs: [],
      source: 'file' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
  };
}

describe('validateDeps (manifest-aware)', () => {
  test('dep satisfied by passed manifest entry — no error', () => {
    const specs: SpecDep[] = [
      { name: 'r2-feature.md', path: '/r2.md', depends: ['parent-feature.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'specs/parent-feature.md', status: 'passed' },
    ]);
    expect(() => validateDeps(specs, manifest)).not.toThrow();
    expect(validateDeps(specs, manifest)).toEqual([]);
  });

  test('match by basename — full path in manifest satisfies filename dep', () => {
    const specs: SpecDep[] = [
      { name: 'r1-calendar.md', path: '/r1.md', depends: ['index-google-calendar.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'specs/index-extension/index-google-calendar.md', status: 'passed' },
    ]);
    expect(() => validateDeps(specs, manifest)).not.toThrow();
    expect(validateDeps(specs, manifest)).toEqual([]);
  });

  test('dep not in manifest or batch — throws error', () => {
    const specs: SpecDep[] = [
      { name: 'child.md', path: '/child.md', depends: ['nonexistent.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'specs/unrelated.md', status: 'passed' },
    ]);
    expect(() => validateDeps(specs, manifest)).toThrow('Unresolved spec dependencies');
    expect(() => validateDeps(specs, manifest)).toThrow('child.md depends on "nonexistent.md"');
  });

  test('dep in manifest but failed — returns warning, no error', () => {
    const specs: SpecDep[] = [
      { name: 'r2-feature.md', path: '/r2.md', depends: ['parent-feature.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'specs/parent-feature.md', status: 'failed' },
    ]);
    const warnings = validateDeps(specs, manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('r2-feature.md depends on parent-feature.md');
    expect(warnings[0]).toContain('status: failed in manifest');
    expect(warnings[0]).toContain('may not be satisfied');
  });

  test('dep in manifest but pending — returns warning, no error', () => {
    const specs: SpecDep[] = [
      { name: 'child.md', path: '/child.md', depends: ['parent.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'parent.md', status: 'pending' },
    ]);
    const warnings = validateDeps(specs, manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('status: pending in manifest');
  });

  test('mixed in-batch and manifest deps — only manifest checked for out-of-batch', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'c.md', path: '/c.md', depends: ['a.md', 'parent.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'specs/parent.md', status: 'passed' },
    ]);
    expect(() => validateDeps(specs, manifest)).not.toThrow();
    expect(validateDeps(specs, manifest)).toEqual([]);
  });

  test('no manifest — current behavior preserved (all deps must be in batch)', () => {
    const specs: SpecDep[] = [
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
    ];
    expect(() => validateDeps(specs)).toThrow('Unresolved spec dependencies');
  });

  test('passed entry takes precedence over failed entry with same basename', () => {
    const specs: SpecDep[] = [
      { name: 'child.md', path: '/child.md', depends: ['parent.md'] },
    ];
    // Two manifest entries for the same basename — passed should win
    const manifest = makeManifest([
      { spec: 'specs/old/parent.md', status: 'failed' },
      { spec: 'specs/new/parent.md', status: 'passed' },
    ]);
    expect(() => validateDeps(specs, manifest)).not.toThrow();
    expect(validateDeps(specs, manifest)).toEqual([]);
  });

  test('returns empty warnings when all deps are in-batch (manifest present)', () => {
    const specs: SpecDep[] = [
      { name: 'a.md', path: '/a.md', depends: [] },
      { name: 'b.md', path: '/b.md', depends: ['a.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'specs/unrelated.md', status: 'passed' },
    ]);
    const warnings = validateDeps(specs, manifest);
    expect(warnings).toEqual([]);
  });

  test('full key match distinguishes same basename in different directories', () => {
    const specs: SpecDep[] = [
      { name: 'child.md', path: '/child.md', depends: ['auth/login.md'] },
    ];
    // auth/login.md is passed, setup/login.md is failed — same basename
    const manifest = makeManifest([
      { spec: 'auth/login.md', status: 'passed' },
      { spec: 'setup/login.md', status: 'failed' },
    ]);
    // Should match the full key auth/login.md (passed), not the basename fallback
    expect(() => validateDeps(specs, manifest)).not.toThrow();
    expect(validateDeps(specs, manifest)).toEqual([]);
  });

  test('full key match returns warning for non-passed dep even if basename is passed elsewhere', () => {
    const specs: SpecDep[] = [
      { name: 'child.md', path: '/child.md', depends: ['setup/login.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'auth/login.md', status: 'passed' },
      { spec: 'setup/login.md', status: 'failed' },
    ]);
    // Should match full key setup/login.md (failed), not basename fallback login.md (passed)
    const warnings = validateDeps(specs, manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('setup/login.md');
    expect(warnings[0]).toContain('status: failed');
  });

  test('bare filename falls back to basename when no full key matches', () => {
    const specs: SpecDep[] = [
      { name: 'child.md', path: '/child.md', depends: ['login.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'auth/login.md', status: 'passed' },
    ]);
    // login.md has no full key match, falls back to basename match -> passed
    expect(() => validateDeps(specs, manifest)).not.toThrow();
    expect(validateDeps(specs, manifest)).toEqual([]);
  });

  test('bare filename basename fallback warns when only non-passed entries exist', () => {
    const specs: SpecDep[] = [
      { name: 'child.md', path: '/child.md', depends: ['login.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'auth/login.md', status: 'failed' },
    ]);
    // login.md has no full key match, falls back to basename match -> failed
    const warnings = validateDeps(specs, manifest);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('login.md');
    expect(warnings[0]).toContain('status: failed');
  });
});

// ── topoSort (manifest-aware) ───────────────────────────────

describe('topoSort (manifest-aware)', () => {
  test('spec with only manifest-satisfied deps goes to level 0', () => {
    const specs: SpecDep[] = [
      { name: 'r2-feature.md', path: '/r2.md', depends: ['parent-feature.md'] },
      { name: 'other.md', path: '/other.md', depends: [] },
    ];
    const manifest = makeManifest([
      { spec: 'specs/parent-feature.md', status: 'passed' },
    ]);
    const levels = topoSort(specs, manifest);
    expect(levels).toHaveLength(1);
    // Both specs should be in level 0 since the dep is manifest-satisfied
    expect(levels[0].specs.map(s => s.name).sort()).toEqual(['other.md', 'r2-feature.md']);
  });

  test('spec with mixed deps waits only for in-batch ones', () => {
    const specs: SpecDep[] = [
      { name: 'base.md', path: '/base.md', depends: [] },
      { name: 'child.md', path: '/child.md', depends: ['base.md', 'parent.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'specs/parent.md', status: 'passed' },
    ]);
    const levels = topoSort(specs, manifest);
    expect(levels).toHaveLength(2);
    expect(levels[0].specs.map(s => s.name)).toEqual(['base.md']);
    expect(levels[1].specs.map(s => s.name)).toEqual(['child.md']);
  });

  test('multiple remediation specs with manifest-satisfied parent deps', () => {
    const specs: SpecDep[] = [
      { name: 'r1-auth.md', path: '/r1.md', depends: ['auth.md'] },
      { name: 'r1-db.md', path: '/r1db.md', depends: ['db.md'] },
      { name: 'r2-api.md', path: '/r2.md', depends: ['auth.md', 'r1-auth.md'] },
    ];
    const manifest = makeManifest([
      { spec: 'specs/auth.md', status: 'passed' },
      { spec: 'specs/db.md', status: 'passed' },
    ]);
    const levels = topoSort(specs, manifest);
    expect(levels).toHaveLength(2);
    // r1-auth.md and r1-db.md have only manifest deps -> level 0
    expect(levels[0].specs.map(s => s.name).sort()).toEqual(['r1-auth.md', 'r1-db.md']);
    // r2-api.md depends on r1-auth.md (in-batch) -> level 1
    expect(levels[1].specs.map(s => s.name)).toEqual(['r2-api.md']);
  });

  test('no manifest — topoSort still requires all deps in batch', () => {
    const specs: SpecDep[] = [
      { name: 'child.md', path: '/child.md', depends: ['parent.md'] },
    ];
    expect(() => topoSort(specs)).toThrow('Unresolved spec dependencies');
  });
});
