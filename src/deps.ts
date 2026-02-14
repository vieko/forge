import { promises as fs } from 'fs';
import path from 'path';

/**
 * Parsed spec with optional dependency metadata from YAML frontmatter.
 */
export interface SpecDep {
  /** Spec filename (e.g. "03-api-endpoints.md") */
  name: string;
  /** Full path to the spec file */
  path: string;
  /** Filenames this spec depends on (from `depends:` frontmatter) */
  depends: string[];
}

/**
 * A level in the topological sort — specs in the same level can run in parallel.
 */
export interface DepLevel {
  specs: SpecDep[];
}

// ── Frontmatter parsing ─────────────────────────────────────

/**
 * Parse YAML frontmatter `depends:` field from a spec file's content.
 * Supports:
 *   depends: [01-foo.md, 02-bar.md]
 *   depends:
 *     - 01-foo.md
 *     - 02-bar.md
 *
 * Returns empty array if no frontmatter or no depends field.
 */
export function parseDependencies(content: string): string[] {
  // Match YAML frontmatter block: starts with --- on first line, ends with ---
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];

  const frontmatter = fmMatch[1];

  // Try inline array: depends: [a.md, b.md]
  const inlineMatch = frontmatter.match(/^depends:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  // Try block array:
  // depends:
  //   - a.md
  //   - b.md
  const blockMatch = frontmatter.match(/^depends:\s*\r?\n((?:\s+-\s+.+\r?\n?)+)/m);
  if (blockMatch) {
    return blockMatch[1]
      .split('\n')
      .map(line => line.replace(/^\s+-\s+/, '').trim())
      .filter(s => s.length > 0);
  }

  return [];
}

// ── DAG construction ────────────────────────────────────────

/**
 * Read all spec files and parse their dependency declarations.
 */
export async function loadSpecDeps(
  specFilePaths: string[],
  specFileNames: string[],
): Promise<SpecDep[]> {
  const specs: SpecDep[] = [];

  for (let i = 0; i < specFileNames.length; i++) {
    const content = await fs.readFile(specFilePaths[i], 'utf-8');
    const depends = parseDependencies(content);
    specs.push({
      name: specFileNames[i],
      path: specFilePaths[i],
      depends,
    });
  }

  return specs;
}

/**
 * Validate that all dependency references point to specs that exist in the batch.
 * Throws with a descriptive error if any are missing.
 */
export function validateDeps(specs: SpecDep[]): void {
  const nameSet = new Set(specs.map(s => s.name));

  const missing: string[] = [];
  for (const spec of specs) {
    for (const dep of spec.depends) {
      if (!nameSet.has(dep)) {
        missing.push(`${spec.name} depends on "${dep}" which is not in the spec batch`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Unresolved spec dependencies:\n  ${missing.join('\n  ')}`);
  }
}

// ── Cycle detection ─────────────────────────────────────────

/**
 * Detect cycles in the dependency graph using DFS.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCycle(specs: SpecDep[]): string[] | null {
  const nameToSpec = new Map(specs.map(s => [s.name, s]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(name: string): string[] | null {
    if (inStack.has(name)) {
      // Found a cycle — return the cycle portion of the path
      const cycleStart = path.indexOf(name);
      return [...path.slice(cycleStart), name];
    }
    if (visited.has(name)) return null;

    visited.add(name);
    inStack.add(name);
    path.push(name);

    const spec = nameToSpec.get(name);
    if (spec) {
      for (const dep of spec.depends) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }

    path.pop();
    inStack.delete(name);
    return null;
  }

  for (const spec of specs) {
    const cycle = dfs(spec.name);
    if (cycle) return cycle;
  }

  return null;
}

// ── Topological sort ────────────────────────────────────────

/**
 * Topological sort using Kahn's algorithm.
 * Returns specs grouped into levels — each level contains specs whose
 * dependencies are all satisfied by previous levels.
 *
 * Specs with no dependencies land in the first level.
 * This enables maximum parallelism within each level.
 */
export function topoSort(specs: SpecDep[]): DepLevel[] {
  // Validate deps exist
  validateDeps(specs);

  // Check for cycles
  const cycle = detectCycle(specs);
  if (cycle) {
    throw new Error(
      `Circular dependency detected: ${cycle.join(' → ')}`
    );
  }

  const nameToSpec = new Map(specs.map(s => [s.name, s]));

  // Compute in-degree for each spec
  const inDegree = new Map<string, number>();
  for (const spec of specs) {
    if (!inDegree.has(spec.name)) inDegree.set(spec.name, 0);
    for (const dep of spec.depends) {
      // dep → spec (spec depends on dep)
      // This means spec has an incoming edge from dep
    }
  }

  // Count incoming edges: for each spec, each dependency adds 1 to its in-degree
  for (const spec of specs) {
    inDegree.set(spec.name, spec.depends.length);
  }

  const levels: DepLevel[] = [];

  // Start with all specs that have no dependencies
  let ready = specs.filter(s => s.depends.length === 0);

  const processed = new Set<string>();

  while (ready.length > 0) {
    // Sort within level for deterministic ordering
    ready.sort((a, b) => a.name.localeCompare(b.name));
    levels.push({ specs: ready });

    for (const s of ready) {
      processed.add(s.name);
    }

    // Find next level: specs whose dependencies are all processed
    const nextReady: SpecDep[] = [];
    for (const spec of specs) {
      if (processed.has(spec.name)) continue;
      if (spec.depends.every(dep => processed.has(dep))) {
        nextReady.push(spec);
      }
    }

    ready = nextReady;
  }

  return levels;
}

/**
 * Check whether any specs in the batch have dependency declarations.
 * Used to determine whether to use dependency-aware execution or fall back to default.
 */
export function hasDependencies(specs: SpecDep[]): boolean {
  return specs.some(s => s.depends.length > 0);
}
