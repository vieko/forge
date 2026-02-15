import type { SpecManifest, SpecEntry, SpecRun } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DIM, RESET, BOLD } from './display.js';
import { parseSource } from './deps.js';

// ── Manifest path ────────────────────────────────────────────

const MANIFEST_FILE = 'specs.json';
const LOCK_FILE = 'specs.json.lock';
const LOCK_STALE_MS = 30_000; // 30 seconds

function manifestPath(workingDir: string): string {
  return path.join(workingDir, '.forge', MANIFEST_FILE);
}

function lockPath(workingDir: string): string {
  return path.join(workingDir, '.forge', LOCK_FILE);
}

// ── File-based lock ──────────────────────────────────────────

async function acquireLock(workingDir: string, maxRetries = 10): Promise<void> {
  const lp = lockPath(workingDir);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // O_CREAT | O_EXCL: atomic create-if-not-exists
      const fd = await fs.open(lp, 'wx');
      await fd.writeFile(String(Date.now()));
      await fd.close();
      return; // Lock acquired
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Lock file exists — check staleness
      try {
        const content = await fs.readFile(lp, 'utf-8');
        const lockTime = parseInt(content, 10);
        if (!isNaN(lockTime) && Date.now() - lockTime > LOCK_STALE_MS) {
          // Stale lock — remove and retry
          await fs.unlink(lp).catch(() => {});
          continue;
        }
      } catch {
        // Can't read lock file — remove and retry
        await fs.unlink(lp).catch(() => {});
        continue;
      }

      // Backoff: 50ms * 2^attempt (max ~25s total)
      const delay = 50 * Math.pow(2, Math.min(attempt, 8));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Could not acquire manifest lock after retries');
}

async function releaseLock(workingDir: string): Promise<void> {
  await fs.unlink(lockPath(workingDir)).catch(() => {});
}

// ── Manifest read/write ──────────────────────────────────────

/** Load the spec manifest. Returns empty manifest if file does not exist. */
export async function loadManifest(workingDir: string): Promise<SpecManifest> {
  try {
    const content = await fs.readFile(manifestPath(workingDir), 'utf-8');
    return JSON.parse(content) as SpecManifest;
  } catch {
    return { version: 1, specs: [] };
  }
}

/** Atomic write: write to tmp, then rename. */
export async function saveManifest(workingDir: string, manifest: SpecManifest): Promise<void> {
  const mp = manifestPath(workingDir);
  const tmp = mp + '.tmp';

  await fs.mkdir(path.dirname(mp), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fs.rename(tmp, mp);
}

// ── Entry helpers ────────────────────────────────────────────

/** Find an existing entry by spec key, or create and append a new one. */
export function findOrCreateEntry(
  manifest: SpecManifest,
  spec: string,
  source: SpecEntry['source'],
): SpecEntry {
  const existing = manifest.specs.find(e => e.spec === spec);
  if (existing) return existing;

  const now = new Date().toISOString();
  const entry: SpecEntry = {
    spec,
    status: 'pending',
    runs: [],
    source,
    createdAt: now,
    updatedAt: now,
  };
  manifest.specs.push(entry);
  return entry;
}

/** Derive top-level status from the latest run. */
export function updateEntryStatus(entry: SpecEntry): void {
  if (entry.runs.length === 0) {
    entry.status = 'pending';
  } else {
    const latest = entry.runs[entry.runs.length - 1];
    entry.status = latest.status;
  }
  entry.updatedAt = new Date().toISOString();
}

// ── Spec identifier helpers ──────────────────────────────────

/** Generate a pipe-based spec identifier from content hash. */
export function pipeSpecId(content: string): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return `pipe:${hash.substring(0, 8)}`;
}

/** Compute relative spec key from an absolute specPath and workingDir. */
export function specKey(specPath: string, workingDir: string): string {
  const rel = path.relative(workingDir, specPath);
  // If the path is outside workingDir, use absolute
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return specPath;
  }
  return rel;
}

// ── Source resolution ────────────────────────────────────────

/** Determine source type from spec content and path. */
export function resolveSpecSource(specContent?: string, specPath?: string): SpecEntry['source'] {
  if (!specPath && !specContent) return 'file';
  if (!specPath && specContent) return 'pipe';

  // Check frontmatter source field
  if (specContent) {
    const source = parseSource(specContent);
    if (source && source.startsWith('github:')) {
      return source as `github:${string}`;
    }
  }

  return 'file';
}

// ── Locked manifest update ───────────────────────────────────

/**
 * Atomically update the manifest with file locking.
 * Loads the manifest, calls the updater, and saves.
 */
export async function withManifestLock(
  workingDir: string,
  updater: (manifest: SpecManifest) => void | Promise<void>,
): Promise<void> {
  await acquireLock(workingDir);
  try {
    const manifest = await loadManifest(workingDir);
    await updater(manifest);
    await saveManifest(workingDir, manifest);
  } finally {
    await releaseLock(workingDir);
  }
}

// ── Reconcile from results history ───────────────────────────

/** Scan .forge/results/ and backfill manifest entries from summary.json files. */
export async function reconcileSpecs(workingDir: string): Promise<number> {
  const resultsDir = path.join(workingDir, '.forge', 'results');
  let resultDirs: string[];
  try {
    resultDirs = await fs.readdir(resultsDir);
  } catch {
    return 0;
  }

  // Collect all results with a specPath
  interface ResultRecord {
    specKey: string;
    runId: string;
    timestamp: string;
    resultPath: string;
    status: 'passed' | 'failed';
    costUsd?: number;
    durationSeconds: number;
  }

  const records: ResultRecord[] = [];
  for (const dir of resultDirs) {
    const summaryPath = path.join(resultsDir, dir, 'summary.json');
    try {
      const content = await fs.readFile(summaryPath, 'utf-8');
      const summary = JSON.parse(content);
      if (!summary.specPath || summary.specPath.startsWith('/dev/fd/')) continue;

      // Normalize specPath to relative key
      let key: string;
      if (path.isAbsolute(summary.specPath)) {
        const rel = path.relative(summary.cwd || workingDir, summary.specPath);
        key = rel.startsWith('..') || path.isAbsolute(rel) ? summary.specPath : rel;
      } else {
        key = summary.specPath;
      }

      records.push({
        specKey: key,
        runId: summary.runId || summary.startedAt,
        timestamp: summary.startedAt,
        resultPath: path.relative(workingDir, path.join(resultsDir, dir)),
        status: summary.status === 'success' ? 'passed' : 'failed',
        costUsd: summary.costUsd,
        durationSeconds: summary.durationSeconds || 0,
      });
    } catch {}
  }

  if (records.length === 0) return 0;

  // Sort by timestamp so runs are appended in order
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let reconciled = 0;
  await withManifestLock(workingDir, (manifest) => {
    // Build set of already-tracked run keys to avoid duplicates
    const existingRuns = new Set<string>();
    for (const entry of manifest.specs) {
      for (const run of entry.runs) {
        existingRuns.add(`${entry.spec}::${run.timestamp}`);
      }
    }

    for (const record of records) {
      const runKey = `${record.specKey}::${record.timestamp}`;
      if (existingRuns.has(runKey)) continue;

      const entry = findOrCreateEntry(manifest, record.specKey, 'file');
      entry.runs.push({
        runId: record.runId,
        timestamp: record.timestamp,
        resultPath: record.resultPath,
        status: record.status,
        costUsd: record.costUsd,
        durationSeconds: record.durationSeconds,
      });
      updateEntryStatus(entry);
      reconciled++;
    }
  });

  return reconciled;
}

/** Remove orphaned entries (file missing) from the manifest. */
export async function pruneSpecs(workingDir: string): Promise<number> {
  let pruned = 0;
  await withManifestLock(workingDir, async (manifest) => {
    const kept: typeof manifest.specs = [];
    for (const entry of manifest.specs) {
      if (entry.source === 'pipe') {
        kept.push(entry);
        continue;
      }
      const absPath = path.isAbsolute(entry.spec)
        ? entry.spec
        : path.join(workingDir, entry.spec);
      try {
        await fs.access(absPath);
        kept.push(entry);
      } catch {
        pruned++;
      }
    }
    manifest.specs = kept;
  });
  return pruned;
}

// ── Add specs to manifest ────────────────────────────────────

/** Resolve a glob or file path to a list of absolute .md file paths. */
async function resolveSpecPaths(pattern: string, workingDir: string): Promise<string[]> {
  const resolved = path.resolve(workingDir, pattern);
  const results: string[] = [];

  // Check if it's a direct file
  try {
    const stat = await fs.stat(resolved);
    if (stat.isFile()) {
      if (resolved.endsWith('.md')) results.push(resolved);
      return results;
    }
    if (stat.isDirectory()) {
      // Recurse into directory for all .md files
      return collectMdFiles(resolved);
    }
  } catch {
    // Not a direct file/dir — treat as glob pattern
  }

  // Simple glob: expand from the base directory
  // Find the first segment without glob characters to use as base
  const parts = pattern.split('/');
  let baseIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].includes('*') || parts[i].includes('?') || parts[i].includes('[')) {
      baseIdx = i;
      break;
    }
    baseIdx = i + 1;
  }

  const baseDir = path.resolve(workingDir, parts.slice(0, baseIdx).join('/') || '.');
  try {
    await fs.access(baseDir);
  } catch {
    return results; // Base directory doesn't exist
  }

  // Collect all .md files under baseDir
  const allFiles = await collectMdFiles(baseDir);

  // Match against the pattern using simple glob matching
  for (const file of allFiles) {
    const rel = path.relative(workingDir, file);
    if (matchGlob(pattern, rel)) {
      results.push(file);
    }
  }

  return results;
}

/** Recursively collect all .md files under a directory. */
async function collectMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const queue = entries.map(e => ({ entry: e, base: dir }));

  while (queue.length > 0) {
    const { entry, base } = queue.shift()!;
    const fullPath = path.join(base, entry.name);
    if (entry.isDirectory()) {
      try {
        const sub = await fs.readdir(fullPath, { withFileTypes: true });
        queue.push(...sub.map(e => ({ entry: e, base: fullPath })));
      } catch {}
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }

  return results;
}

/** Simple glob matcher supporting * and ** patterns. */
function matchGlob(pattern: string, filePath: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .split('/')
    .map(segment => {
      if (segment === '**') return '.*';
      return segment
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars (except * and ?)
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
    })
    .join('/');

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

/** Add spec files to the manifest by path or glob pattern. Returns count of newly added specs. */
export async function addSpecs(patterns: string[], workingDir: string): Promise<number> {
  // Resolve all patterns to absolute paths
  const allPaths = new Set<string>();
  for (const pattern of patterns) {
    const resolved = await resolveSpecPaths(pattern, workingDir);
    for (const p of resolved) allPaths.add(p);
  }

  if (allPaths.size === 0) return 0;

  let added = 0;
  await withManifestLock(workingDir, (manifest) => {
    const trackedSpecs = new Set(manifest.specs.map(e => {
      return path.isAbsolute(e.spec)
        ? e.spec
        : path.resolve(workingDir, e.spec);
    }));

    for (const absPath of allPaths) {
      if (trackedSpecs.has(absPath)) continue;

      const rel = path.relative(workingDir, absPath);
      const key = rel.startsWith('..') || path.isAbsolute(rel) ? absPath : rel;
      findOrCreateEntry(manifest, key, 'file');
      added++;
    }
  });

  return added;
}

// ── showSpecs command ────────────────────────────────────────

export interface ShowSpecsOptions {
  cwd?: string;
  pending?: boolean;
  failed?: boolean;
  passed?: boolean;
  orphaned?: boolean;
  untracked?: boolean;
  reconcile?: boolean;
  prune?: boolean;
  add?: string;
}

export async function showSpecs(options: ShowSpecsOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();

  // Reconcile from results history if requested
  if (options.reconcile) {
    const count = await reconcileSpecs(workingDir);
    if (count > 0) {
      console.log(`${BOLD}Reconciled ${count} run(s) from .forge/results/${RESET}\n`);
    } else {
      console.log(`${DIM}No new runs to reconcile.${RESET}\n`);
    }
  }

  // Prune orphaned entries if requested
  if (options.prune) {
    const count = await pruneSpecs(workingDir);
    if (count > 0) {
      console.log(`${BOLD}Pruned ${count} orphaned spec(s)${RESET}\n`);
    } else {
      console.log(`${DIM}No orphaned specs to prune.${RESET}\n`);
    }
  }

  // Add specs from path/glob if requested
  if (options.add) {
    const count = await addSpecs([options.add], workingDir);
    if (count > 0) {
      console.log(`${BOLD}Added ${count} spec(s) to manifest${RESET}\n`);
    } else {
      console.log(`${DIM}No new specs to add (already tracked or no .md files found).${RESET}\n`);
    }
    return;
  }

  const manifest = await loadManifest(workingDir);

  const filterActive = !!(options.pending || options.failed || options.passed || options.orphaned || options.untracked);

  // Collect entries with orphan detection
  interface DisplayEntry {
    status: string;
    spec: string;
    runs: number;
    cost: number;
    duration: number;
    orphaned: boolean;
  }

  const entries: DisplayEntry[] = [];

  for (const entry of manifest.specs) {
    // Check if the spec file still exists
    let fileExists = true;
    if (entry.source !== 'pipe') {
      const absPath = path.isAbsolute(entry.spec)
        ? entry.spec
        : path.join(workingDir, entry.spec);
      try {
        await fs.access(absPath);
      } catch {
        fileExists = false;
      }
    }

    const isOrphaned = !fileExists && entry.source !== 'pipe';
    const displayStatus = isOrphaned ? 'orphaned' : entry.status;

    // Apply filters
    if (filterActive) {
      if (options.pending && displayStatus !== 'pending') continue;
      if (options.failed && displayStatus !== 'failed') continue;
      if (options.passed && displayStatus !== 'passed') continue;
      if (options.orphaned && !isOrphaned) continue;
      if (options.untracked) continue; // untracked entries come from filesystem scan, not manifest
    }

    const totalCost = entry.runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const totalDuration = entry.runs.reduce((sum, r) => sum + r.durationSeconds, 0);

    entries.push({
      status: displayStatus,
      spec: entry.spec,
      runs: entry.runs.length,
      cost: totalCost,
      duration: totalDuration,
      orphaned: isOrphaned,
    });
  }

  // Untracked detection: scan known spec directories
  const untrackedEntries: string[] = [];
  if (!filterActive || options.untracked) {
    // Discover spec directories from manifest entries
    const specDirs = new Set<string>();
    for (const entry of manifest.specs) {
      if (entry.source === 'pipe') continue;
      const absPath = path.isAbsolute(entry.spec)
        ? entry.spec
        : path.join(workingDir, entry.spec);
      specDirs.add(path.dirname(absPath));
    }

    // Also check common locations
    for (const dir of ['specs', '.bonfire/specs']) {
      const absDir = path.join(workingDir, dir);
      try {
        await fs.access(absDir);
        specDirs.add(absDir);
      } catch {}
    }

    const trackedSpecs = new Set(manifest.specs.map(e => {
      return path.isAbsolute(e.spec)
        ? e.spec
        : path.resolve(workingDir, e.spec);
    }));

    // Remove subdirectories already covered by a parent in specDirs
    const sortedDirs = [...specDirs].sort();
    const rootDirs = sortedDirs.filter((dir, _i, arr) =>
      !arr.some(parent => parent !== dir && dir.startsWith(parent + path.sep)),
    );

    const seen = new Set<string>();
    for (const dir of rootDirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const queue = [...entries.map(e => ({ entry: e, base: dir }))];
        while (queue.length > 0) {
          const { entry, base } = queue.shift()!;
          const fullPath = path.join(base, entry.name);
          if (entry.isDirectory()) {
            try {
              const sub = await fs.readdir(fullPath, { withFileTypes: true });
              queue.push(...sub.map(e => ({ entry: e, base: fullPath })));
            } catch {}
          } else if (entry.name.endsWith('.md') && !trackedSpecs.has(fullPath) && !seen.has(fullPath)) {
            seen.add(fullPath);
            const rel = path.relative(workingDir, fullPath);
            untrackedEntries.push(rel.startsWith('..') ? fullPath : rel);
          }
        }
      } catch {}
    }
  }

  // Display
  if (entries.length === 0 && untrackedEntries.length === 0) {
    if (filterActive) {
      console.log(`${DIM}No specs match the filter.${RESET}`);
    } else {
      console.log(`${DIM}No tracked specs. Run ${RESET}forge run --spec${DIM} or ${RESET}forge run --spec-dir${DIM} to start tracking.${RESET}`);
    }
    return;
  }

  // Status color mapping
  const statusColor = (s: string): string => {
    switch (s) {
      case 'passed': return '\x1b[32m';  // green
      case 'failed': return '\x1b[31m';  // red
      case 'pending': return DIM;         // gray
      case 'running': return '\x1b[36m';  // cyan
      case 'orphaned': return '\x1b[33m'; // yellow
      default: return '';
    }
  };

  // Combine tracked + untracked for unified display
  const allItems: Array<DisplayEntry & { untracked?: boolean }> = [...entries];
  if (untrackedEntries.length > 0 && (!filterActive || options.untracked)) {
    for (const u of untrackedEntries) {
      allItems.push({ status: 'untracked', spec: u, runs: 0, cost: 0, duration: 0, orphaned: false, untracked: true });
    }
  }

  // Find common prefix to strip
  const allPaths = allItems.map(e => e.spec);
  let commonPrefix = '';
  if (allPaths.length > 1) {
    const parts = allPaths[0].split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(0, i + 1).join('/') + '/';
      if (allPaths.every(p => p.startsWith(candidate))) {
        commonPrefix = candidate;
      } else break;
    }
  }

  // Group by directory (after stripping prefix)
  const groups = new Map<string, typeof allItems>();
  for (const item of allItems) {
    const stripped = commonPrefix ? item.spec.slice(commonPrefix.length) : item.spec;
    const dir = stripped.includes('/') ? stripped.split('/').slice(0, -1).join('/') : '.';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(item);
  }

  // Compute dynamic column width for filenames
  const nameWidth = Math.max(20, ...allItems.map(e => {
    const stripped = commonPrefix ? e.spec.slice(commonPrefix.length) : e.spec;
    const name = stripped.includes('/') ? stripped.split('/').pop()! : stripped;
    return name.length;
  }));

  // Print header with common prefix
  if (commonPrefix) {
    console.log(`${DIM}${commonPrefix}${RESET}\n`);
  }

  // Print groups
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    // Root group first, then alphabetical
    if (a[0] === '.') return -1;
    if (b[0] === '.') return 1;
    return a[0].localeCompare(b[0]);
  });

  let totalCost = 0;
  let totalDuration = 0;

  for (const [dir, items] of sortedGroups) {
    if (sortedGroups.length > 1 && dir !== '.') {
      console.log(`  ${BOLD}${dir}/${RESET}`);
    }

    for (const e of items) {
      const stripped = commonPrefix ? e.spec.slice(commonPrefix.length) : e.spec;
      const name = stripped.includes('/') ? stripped.split('/').pop()! : stripped;
      const color = e.untracked ? DIM : statusColor(e.status);
      const status = e.untracked ? 'untracked' : e.status;
      const indent = sortedGroups.length > 1 && dir !== '.' ? '    ' : '  ';

      totalCost += e.cost;
      totalDuration += e.duration;

      if (e.runs > 0) {
        const runLabel = e.runs === 1 ? '1 run ' : `${e.runs} runs`;
        const costStr = e.cost > 0 ? `$${e.cost.toFixed(2)}` : '';
        const durStr = e.duration > 0 ? `${Math.round(e.duration)}s` : '';
        const suffix = e.orphaned ? `  ${DIM}(file missing)${RESET}` : '';
        console.log(`${indent}${color}${status.padEnd(10)}${RESET} ${name.padEnd(nameWidth)} ${runLabel.padEnd(8)} ${costStr.padStart(7)}   ${durStr.padStart(5)}${suffix}`);
      } else {
        console.log(`${indent}${color}${status.padEnd(10)}${RESET} ${name}`);
      }
    }

    if (sortedGroups.length > 1) console.log('');
  }

  // Summary
  const total = manifest.specs.length;
  const passed = manifest.specs.filter(e => e.status === 'passed').length;
  const failed = manifest.specs.filter(e => e.status === 'failed').length;
  const pending = manifest.specs.filter(e => e.status === 'pending').length;

  const parts: string[] = [];
  if (passed > 0) parts.push(`\x1b[32m${passed} passed\x1b[0m`);
  if (failed > 0) parts.push(`\x1b[31m${failed} failed\x1b[0m`);
  if (pending > 0) parts.push(`${DIM}${pending} pending${RESET}`);
  if (untrackedEntries.length > 0 && (!filterActive || options.untracked)) {
    parts.push(`${untrackedEntries.length} untracked`);
  }

  if (total > 0 || untrackedEntries.length > 0) {
    const countLabel = total > 0 ? `${total} spec(s)` : '';
    const costLabel = totalCost > 0 ? `$${totalCost.toFixed(2)}` : '';
    const durLabel = totalDuration > 0 ? `${Math.round(totalDuration)}s` : '';
    const meta = [costLabel, durLabel].filter(Boolean).join(', ');
    console.log(`${DIM}${countLabel}${parts.length > 0 ? ': ' : ''}${RESET}${parts.join(', ')}${meta ? `  ${DIM}(${meta})${RESET}` : ''}`);
  }
}
