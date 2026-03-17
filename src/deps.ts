import { promises as fs } from 'fs';
import path from 'path';
import type { SpecManifest } from './types.js';

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
  /** Monorepo package scope (from `scope:` frontmatter, e.g. "packages/api") */
  scope?: string;
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
 * Falls back to markdown-style dependency declarations:
 *   **Depends on**: [label](./01-foo.md)
 *   **Depends on**: [label](./01-foo.md), [label](./02-bar.md)
 *
 * Returns empty array if no dependencies found.
 */
export function parseDependencies(content: string): string[] {
  // Try YAML frontmatter first
  const fmDeps = parseFrontmatterDependencies(content);
  if (fmDeps.length > 0) return fmDeps;

  // Fall back to markdown-style **Depends on**: [label](./file.md)
  return parseMarkdownDependencies(content);
}

function parseFrontmatterDependencies(content: string): string[] {
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

function parseMarkdownDependencies(content: string): string[] {
  // Match: **Depends on**: [label](./file.md) or **Dependencies**: [label](./file.md)
  const mdMatch = content.match(/^\*\*Depends?\s*(?:on|encies)?\*\*:\s*(.+)$/mi);
  if (!mdMatch) return [];

  const line = mdMatch[1];
  const deps: string[] = [];

  // Extract filenames from markdown links: [label](./path/to/file.md)
  const linkRegex = /\[([^\]]*)\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = linkRegex.exec(line)) !== null) {
    // Extract just the basename from the path
    const linkPath = match[2];
    const basename = linkPath.split('/').pop()!;
    deps.push(basename);
  }

  return deps;
}

/**
 * Parse YAML frontmatter `source:` field from a spec file's content.
 * Supports: source: github:owner/repo#42
 *
 * Returns undefined if no frontmatter or no source field.
 */
export function parseSource(content: string): string | undefined {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;

  const frontmatter = fmMatch[1];
  const sourceMatch = frontmatter.match(/^source:\s*(.+)$/m);
  if (!sourceMatch) return undefined;

  return sourceMatch[1].trim();
}

/**
 * Parse YAML frontmatter `scope:` field from a spec file's content.
 * Identifies the target package directory within a monorepo.
 *
 * Supports: scope: packages/api
 *           scope: apps/web
 *
 * Returns undefined if no frontmatter or no scope field.
 */
export function parseScope(content: string): string | undefined {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;

  const frontmatter = fmMatch[1];
  const scopeMatch = frontmatter.match(/^scope:\s*(.+)$/m);
  if (!scopeMatch) return undefined;

  // Normalize: strip leading/trailing slashes and whitespace
  return scopeMatch[1].trim().replace(/^\/+|\/+$/g, '');
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
    const scope = parseScope(content);
    specs.push({
      name: specFileNames[i],
      path: specFilePaths[i],
      depends,
      ...(scope && { scope }),
    });
  }

  return specs;
}

/**
 * Validate that all dependency references point to specs that exist in the batch
 * or are satisfied by passed specs in the manifest.
 *
 * When a manifest is provided:
 * - A dependency matched by filename to a `passed` manifest entry is satisfied.
 * - A dependency matched to a non-passed manifest entry emits a warning (returned).
 * - A dependency not found in the batch or manifest throws an error.
 *
 * Without a manifest, all deps must be in the batch (original behavior).
 *
 * @returns Array of warning strings (empty if none).
 */
export function validateDeps(specs: SpecDep[], manifest?: SpecManifest): string[] {
  const nameSet = new Set(specs.map(s => s.name));
  const warnings: string[] = [];

  // Build manifest lookup by full spec key (primary) and basename (backward-compatible fallback).
  // Full keys distinguish specs like auth/login.md vs setup/login.md.
  const manifestPassedKeys = new Set<string>();           // full spec key
  const manifestPassedNames = new Set<string>();           // basename fallback
  const manifestNonPassedKeys = new Map<string, string>(); // full key -> status
  const manifestNonPassedNames = new Map<string, string>(); // basename -> status (fallback)
  if (manifest) {
    for (const entry of manifest.specs) {
      const key = entry.spec;
      const basename = path.basename(entry.spec);
      if (entry.status === 'passed') {
        manifestPassedKeys.add(key);
        manifestNonPassedKeys.delete(key);
        manifestPassedNames.add(basename);
        manifestNonPassedNames.delete(basename); // passed takes precedence
      } else {
        if (!manifestPassedKeys.has(key)) {
          manifestNonPassedKeys.set(key, entry.status);
        }
        if (!manifestPassedNames.has(basename)) {
          manifestNonPassedNames.set(basename, entry.status);
        }
      }
    }
  }

  const missing: string[] = [];
  for (const spec of specs) {
    for (const dep of spec.depends) {
      if (nameSet.has(dep)) continue;

      // Primary: match dep against full spec keys
      if (manifestPassedKeys.has(dep)) continue;

      const nonPassedKeyStatus = manifestNonPassedKeys.get(dep);
      if (nonPassedKeyStatus !== undefined) {
        warnings.push(`${spec.name} depends on ${dep} (status: ${nonPassedKeyStatus} in manifest) — may not be satisfied`);
        continue;
      }

      // Fallback: match dep basename against manifest basenames (backward compat)
      const depBasename = path.basename(dep);
      if (manifestPassedNames.has(depBasename)) continue;

      const nonPassedNameStatus = manifestNonPassedNames.get(depBasename);
      if (nonPassedNameStatus !== undefined) {
        warnings.push(`${spec.name} depends on ${dep} (status: ${nonPassedNameStatus} in manifest) — may not be satisfied`);
        continue;
      }

      missing.push(`${spec.name} depends on "${dep}" which is not in the spec batch`);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Unresolved spec dependencies:\n  ${missing.join('\n  ')}`);
  }

  return warnings;
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
 *
 * When a manifest is provided, dependencies satisfied by passed manifest
 * entries are excluded from ordering — a spec whose only deps are
 * manifest-satisfied goes in level 0 (runs immediately).
 */
export function topoSort(specs: SpecDep[], manifest?: SpecManifest): DepLevel[] {
  // Validate deps exist (with manifest awareness)
  const warnings = validateDeps(specs, manifest);
  for (const w of warnings) {
    console.warn(`\x1b[33m[forge]\x1b[0m Warning: ${w}`);
  }

  // Check for cycles
  const cycle = detectCycle(specs);
  if (cycle) {
    throw new Error(
      `Circular dependency detected: ${cycle.join(' → ')}`
    );
  }

  // For topo ordering, only consider in-batch deps.
  // Out-of-batch deps are either manifest-satisfied or validated above.
  const nameSet = new Set(specs.map(s => s.name));
  const inBatchDeps = new Map<string, string[]>();
  for (const spec of specs) {
    inBatchDeps.set(spec.name, spec.depends.filter(d => nameSet.has(d)));
  }

  const levels: DepLevel[] = [];

  // Start with all specs that have no in-batch dependencies
  let ready = specs.filter(s => inBatchDeps.get(s.name)!.length === 0);

  const processed = new Set<string>();

  while (ready.length > 0) {
    // Sort within level for deterministic ordering
    ready.sort((a, b) => a.name.localeCompare(b.name));
    levels.push({ specs: ready });

    for (const s of ready) {
      processed.add(s.name);
    }

    // Find next level: specs whose in-batch dependencies are all processed
    const nextReady: SpecDep[] = [];
    for (const spec of specs) {
      if (processed.has(spec.name)) continue;
      if (inBatchDeps.get(spec.name)!.every(dep => processed.has(dep))) {
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
