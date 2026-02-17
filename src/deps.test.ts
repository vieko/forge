import { describe, test, expect } from 'bun:test';
import { parseDependencies, parseSource, topoSort, detectCycle, validateDeps, hasDependencies, type SpecDep } from './deps.js';

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
