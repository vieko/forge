import type { SpecManifest, SpecEntry, SpecRun } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { DIM, RESET, BOLD, CMD, printRunSummary } from './display.js';
import { runQuery } from './core.js';
import { resolveConfig, ensureForgeDir } from './utils.js';
import { parseSource } from './deps.js';
import { getDb, listSpecEntries, getSpecRunsByEntry, type SpecEntryRow } from './db.js';
import type { Database } from 'bun:sqlite';

// ── Spec complexity assessment ───────────────────────────────

export interface ComplexityWarning {
  file: string;
  criteria: number;
  words: number;
  sections: number;
  reasons: string[];
}

const MAX_CRITERIA = 8;
const MAX_WORDS = 500;
const MAX_SECTIONS = 6;

/**
 * Assess a spec's complexity. Returns a warning if the spec exceeds thresholds,
 * or null if within acceptable limits.
 */
export function assessSpecComplexity(file: string, content: string): ComplexityWarning | null {
  const reasons: string[] = [];

  // Count acceptance criteria: lines matching "- " under "## Acceptance Criteria"
  const acMatch = content.match(/## Acceptance Criteria\s*\n([\s\S]*?)(?=\n## |\n---|\s*$)/);
  const criteria = acMatch
    ? acMatch[1].split('\n').filter(line => /^\s*- /.test(line)).length
    : 0;
  if (criteria > MAX_CRITERIA) {
    reasons.push(`${criteria} acceptance criteria (recommended: 6-8)`);
  }

  // Count words (excluding frontmatter)
  const bodyContent = content.replace(/^---[\s\S]*?---\s*/, '');
  const words = bodyContent.split(/\s+/).filter(w => w.length > 0).length;
  if (words > MAX_WORDS) {
    reasons.push(`${words} words (recommended: <${MAX_WORDS})`);
  }

  // Count H2 sections
  const sections = (content.match(/^## /gm) || []).length;
  if (sections > MAX_SECTIONS) {
    reasons.push(`${sections} sections (recommended: <=${MAX_SECTIONS})`);
  }

  if (reasons.length === 0) return null;

  return { file, criteria, words, sections, reasons };
}

// ── Manifest path ────────────────────────────────────────────

const MANIFEST_FILE = 'specs.json';

function manifestPath(workingDir: string): string {
  return path.join(workingDir, '.forge', MANIFEST_FILE);
}

// ── In-process mutex per working directory ───────────────────

const dirMutexes = new Map<string, Promise<void>>();

/** Acquire a per-directory mutex. Returns a release function. */
function acquireSpecMutex(workingDir: string): Promise<() => void> {
  const key = path.resolve(workingDir);
  const prev = dirMutexes.get(key) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  dirMutexes.set(key, next);

  return prev.then(() => release);
}

// ── JSON file helpers (internal) ─────────────────────────────

/** Load manifest from JSON file. Returns empty manifest if file does not exist or is invalid. */
async function loadManifestFromJson(workingDir: string): Promise<SpecManifest> {
  try {
    const content = await fs.readFile(manifestPath(workingDir), 'utf-8');
    return JSON.parse(content) as SpecManifest;
  } catch {
    return { version: 1, specs: [] };
  }
}

/** Atomic JSON export: write to tmp, then rename. */
async function exportManifestJson(workingDir: string, manifest: SpecManifest): Promise<void> {
  const mp = manifestPath(workingDir);
  const tmp = mp + '.tmp';

  await ensureForgeDir(workingDir);
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fs.rename(tmp, mp);
}

// ── DB helpers (internal) ────────────────────────────────────

/** In-memory tracking of which directories have had JSON->DB migration checked. */
const migratedDirs = new Set<string>();

/** Load manifest from spec_entries + spec_runs DB tables. */
function loadManifestFromDb(db: Database): SpecManifest {
  const entries = listSpecEntries(db);
  const specs: SpecEntry[] = entries.map(row => {
    const runs = getSpecRunsByEntry(db, row.id)
      .reverse() // DB returns DESC (newest first), manifest expects ASC (chronological)
      .map(r => ({
        runId: r.run_id,
        timestamp: r.timestamp,
        status: r.status as 'passed' | 'failed',
        costUsd: r.cost_usd ?? undefined,
        durationSeconds: r.duration_seconds ?? 0,
        numTurns: r.num_turns ?? undefined,
        verifyAttempts: r.verify_attempts ?? undefined,
      }));
    return {
      spec: row.spec,
      status: row.status as SpecEntry['status'],
      runs,
      source: row.source as SpecEntry['source'],
      workGroupId: row.work_group_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
  return { version: 1, specs };
}

/** Sync manifest to DB tables. Must be called inside an active transaction or standalone. */
function syncManifestToDbInner(db: Database, manifest: SpecManifest): void {
  const existing = new Map<string, SpecEntryRow>();
  for (const row of listSpecEntries(db)) {
    existing.set(row.spec, row);
  }

  const seen = new Set<string>();
  for (const entry of manifest.specs) {
    seen.add(entry.spec);
    const existingRow = existing.get(entry.spec);

    if (existingRow) {
      db.run(
        'UPDATE spec_entries SET status = ?, source = ?, work_group_id = COALESCE(?, work_group_id), updated_at = ? WHERE id = ?',
        [entry.status, entry.source, entry.workGroupId ?? null, entry.updatedAt, existingRow.id],
      );
      db.run('DELETE FROM spec_runs WHERE spec_entry_id = ?', [existingRow.id]);
      for (const run of entry.runs) {
        db.run(
          `INSERT INTO spec_runs (id, spec_entry_id, run_id, timestamp, status, cost_usd, duration_seconds, num_turns, verify_attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), existingRow.id, run.runId, run.timestamp, run.status,
           run.costUsd ?? null, run.durationSeconds, run.numTurns ?? null, run.verifyAttempts ?? null],
        );
      }
    } else {
      const entryId = crypto.randomUUID();
      db.run(
        `INSERT INTO spec_entries (id, spec, status, source, work_group_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [entryId, entry.spec, entry.status, entry.source, entry.workGroupId ?? null, entry.createdAt, entry.updatedAt],
      );
      for (const run of entry.runs) {
        db.run(
          `INSERT INTO spec_runs (id, spec_entry_id, run_id, timestamp, status, cost_usd, duration_seconds, num_turns, verify_attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), entryId, run.runId, run.timestamp, run.status,
           run.costUsd ?? null, run.durationSeconds, run.numTurns ?? null, run.verifyAttempts ?? null],
        );
      }
    }
  }

  // Delete entries not in manifest (pruned)
  for (const [_spec, row] of existing) {
    if (!seen.has(row.spec)) {
      db.run('DELETE FROM spec_runs WHERE spec_entry_id = ?', [row.id]);
      db.run('DELETE FROM spec_entries WHERE id = ?', [row.id]);
    }
  }
}

/** Sync manifest to DB tables in a standalone transaction. */
function syncManifestToDb(db: Database, manifest: SpecManifest): void {
  db.transaction(() => {
    syncManifestToDbInner(db, manifest);
  })();
}

/** Auto-migrate: if spec_entries is empty and JSON has data, import it. Idempotent. */
async function ensureMigration(db: Database, workingDir: string): Promise<void> {
  const resolved = path.resolve(workingDir);
  if (migratedDirs.has(resolved)) return;
  migratedDirs.add(resolved);

  const existing = listSpecEntries(db);
  if (existing.length > 0) return;

  const manifest = await loadManifestFromJson(workingDir);
  if (manifest.specs.length === 0) return;

  syncManifestToDb(db, manifest);
}

// ── Manifest read/write ──────────────────────────────────────

/** Load the spec manifest. Reads from DB (with auto-migration), falls back to JSON if DB unavailable. */
export async function loadManifest(workingDir: string): Promise<SpecManifest> {
  const db = getDb(workingDir);
  if (!db) return loadManifestFromJson(workingDir);

  await ensureMigration(db, workingDir);
  return loadManifestFromDb(db);
}

/** Save manifest to DB tables, then export JSON for backward compatibility. */
export async function saveManifest(workingDir: string, manifest: SpecManifest): Promise<void> {
  const db = getDb(workingDir);
  if (db) {
    syncManifestToDb(db, manifest);
  }
  await exportManifestJson(workingDir, manifest);
}

// ── Entry helpers ────────────────────────────────────────────

/** Find an existing entry by spec key, or create and append a new one. */
export function findOrCreateEntry(
  manifest: SpecManifest,
  spec: string,
  source: SpecEntry['source'],
  workGroupId?: string,
): SpecEntry {
  const existing = manifest.specs.find(e => e.spec === spec);
  if (existing) {
    // Assign work group ID to existing entry if not already set
    if (workGroupId && !existing.workGroupId) {
      existing.workGroupId = workGroupId;
      existing.updatedAt = new Date().toISOString();
    }
    return existing;
  }

  const now = new Date().toISOString();
  const entry: SpecEntry = {
    spec,
    status: 'pending',
    runs: [],
    source,
    workGroupId,
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

// ── Transaction-based manifest update ────────────────────────

/**
 * Atomically update the manifest using SQLite transactions.
 * Loads from DB, calls the updater, saves to DB, then exports JSON.
 * Uses an in-process mutex to serialize concurrent access within the same process.
 * SQLite WAL mode + busy_timeout handles multi-process serialization.
 */
export async function withSpecTransaction(
  workingDir: string,
  updater: (manifest: SpecManifest) => void | Promise<void>,
): Promise<void> {
  const release = await acquireSpecMutex(workingDir);
  try {
    const db = getDb(workingDir);

    if (!db) {
      // Graceful degradation: JSON-only path
      await ensureForgeDir(workingDir);
      const manifest = await loadManifestFromJson(workingDir);
      await updater(manifest);
      await exportManifestJson(workingDir, manifest);
      return;
    }

    await ensureMigration(db, workingDir);
    const manifest = loadManifestFromDb(db);
    await updater(manifest);
    syncManifestToDb(db, manifest);
    await exportManifestJson(workingDir, manifest);
  } finally {
    release();
  }
}

/** @deprecated Use withSpecTransaction instead. */
export const withManifestLock = withSpecTransaction;

// ── Manifest cleanup on cancel ───────────────────────────────

/**
 * Reset any specs with status 'running' back to 'pending'.
 * Called when a CLI task is cancelled (Ctrl-C) to prevent stuck-running-specs.
 */
export async function resetRunningSpecs(workingDir: string): Promise<number> {
  let resetCount = 0;
  await withSpecTransaction(workingDir, (manifest) => {
    for (const entry of manifest.specs) {
      if (entry.status === 'running') {
        entry.status = 'pending';
        entry.updatedAt = new Date().toISOString();
        resetCount++;
      }
    }
  });
  return resetCount;
}

// ── Reconcile from results history ───────────────────────────

/** Query the runs DB table and reconcile manifest entries for spec-associated runs. */
export async function reconcileSpecs(workingDir: string): Promise<number> {
  // Graceful degradation: if DB is unavailable, return 0 with no crash
  const db = getDb(workingDir);
  if (!db) return 0;

  // Query all runs with a non-null specPath, ordered by createdAt
  interface RunRecord {
    id: string;
    specPath: string;
    status: string;
    costUsd: number | null;
    durationSeconds: number;
    batchId: string | null;
    createdAt: string;
    cwd: string;
  }

  let rows: RunRecord[];
  try {
    rows = db.query(
      `SELECT id, specPath, status, costUsd, durationSeconds, batchId, createdAt, cwd
       FROM runs
       WHERE specPath IS NOT NULL
       ORDER BY createdAt ASC`,
    ).all() as RunRecord[];
  } catch {
    return 0;
  }

  if (rows.length === 0) return 0;

  // Build records with normalized spec keys
  interface ResultRecord {
    specKey: string;
    runId: string;
    timestamp: string;
    status: 'passed' | 'failed';
    costUsd?: number;
    durationSeconds: number;
  }

  const records: ResultRecord[] = [];
  for (const row of rows) {
    // Skip pipe-based specs
    if (row.specPath.startsWith('/dev/fd/')) continue;

    // Normalize specPath to relative key
    let key: string;
    if (path.isAbsolute(row.specPath)) {
      const rel = path.relative(row.cwd || workingDir, row.specPath);
      key = rel.startsWith('..') || path.isAbsolute(rel) ? row.specPath : rel;
    } else {
      key = row.specPath;
    }

    records.push({
      specKey: key,
      runId: row.id,
      timestamp: row.createdAt,
      status: row.status === 'success' ? 'passed' : 'failed',
      costUsd: row.costUsd ?? undefined,
      durationSeconds: row.durationSeconds,
    });
  }

  if (records.length === 0) return 0;

  let reconciled = 0;
  await withSpecTransaction(workingDir, (manifest) => {
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
  await withSpecTransaction(workingDir, async (manifest) => {
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
  await withSpecTransaction(workingDir, (manifest) => {
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

// ── Resolve spec (mark as passed without running) ────────────

export async function resolveSpecs(patterns: string[], workingDir: string): Promise<number> {
  let resolved = 0;
  await withSpecTransaction(workingDir, (manifest) => {
    for (const pattern of patterns) {
      // Match by exact key, basename, or trailing path
      const entry = manifest.specs.find(e =>
        e.spec === pattern
        || path.basename(e.spec) === pattern
        || e.spec.endsWith('/' + pattern)
      );
      if (!entry) continue;
      if (entry.status === 'passed') continue;

      entry.runs.push({
        runId: 'manual',
        timestamp: new Date().toISOString(),
        status: 'passed',
        durationSeconds: 0,
      });
      updateEntryStatus(entry);
      resolved++;
    }
  });
  return resolved;
}

// ── Unresolve spec (reset to pending) ────────────────────────

export async function unresolveSpecs(patterns: string[], workingDir: string): Promise<number> {
  let unresolved = 0;
  await withSpecTransaction(workingDir, (manifest) => {
    for (const pattern of patterns) {
      const entry = manifest.specs.find(e =>
        e.spec === pattern
        || path.basename(e.spec) === pattern
        || e.spec.endsWith('/' + pattern)
      );
      if (!entry) continue;
      if (entry.status === 'pending') continue;

      entry.status = 'pending';
      entry.runs = [];
      entry.updatedAt = new Date().toISOString();
      unresolved++;
    }
  });
  return unresolved;
}

// ── Known spec directories ───────────────────────────────────

/** Collect known spec directories: parent dirs of manifest entries + well-known dirs, deduplicated. */
export async function knownSpecDirs(workingDir: string, manifest?: SpecManifest): Promise<string[]> {
  const m = manifest ?? await loadManifest(workingDir);
  const specDirs = new Set<string>();

  for (const entry of m.specs) {
    if (entry.source === 'pipe') continue;
    const absPath = path.isAbsolute(entry.spec)
      ? entry.spec
      : path.join(workingDir, entry.spec);
    specDirs.add(path.dirname(absPath));
  }

  for (const dir of ['specs', '.bonfire/specs']) {
    const absDir = path.join(workingDir, dir);
    try {
      await fs.access(absDir);
      specDirs.add(absDir);
    } catch {}
  }

  // Remove subdirectories already covered by a parent
  const sortedDirs = [...specDirs].sort();
  return sortedDirs.filter((dir, _i, arr) =>
    !arr.some(parent => parent !== dir && dir.startsWith(parent + path.sep)),
  );
}

// ── Untracked detection ──────────────────────────────────────

// Scan known spec directories for .md files not in the manifest
export async function findUntrackedSpecs(workingDir: string): Promise<string[]> {
  const manifest = await loadManifest(workingDir);
  const rootDirs = await knownSpecDirs(workingDir, manifest);

  const trackedSpecs = new Set(manifest.specs.map(e => {
    return path.isAbsolute(e.spec)
      ? e.spec
      : path.resolve(workingDir, e.spec);
  }));

  const seen = new Set<string>();
  const untracked: string[] = [];
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
          untracked.push(rel.startsWith('..') ? fullPath : rel);
        }
      }
    } catch {}
  }

  return untracked;
}

// ── Spec path shorthand resolution ───────────────────────────

/**
 * Resolve a shorthand spec file path to an absolute path.
 * Tries: direct path → manifest 3-level match → directory scan by basename.
 * Returns null if nothing found.
 */
export async function resolveSpecFile(input: string, workingDir: string): Promise<string | null> {
  // 1. Direct path
  const direct = path.resolve(workingDir, input);
  try {
    await fs.access(direct);
    return direct;
  } catch {}

  // 2. Manifest lookup (exact key → basename → trailing path)
  const manifest = await loadManifest(workingDir);
  const entry = manifest.specs.find(e =>
    e.spec === input
    || path.basename(e.spec) === input
    || e.spec.endsWith('/' + input)
  );
  if (entry) {
    const absPath = path.isAbsolute(entry.spec)
      ? entry.spec
      : path.resolve(workingDir, entry.spec);
    try {
      await fs.access(absPath);
      return absPath;
    } catch {}
  }

  // 3. Directory scan: search known spec dirs for a file matching by basename
  const basename = path.basename(input);
  const dirs = await knownSpecDirs(workingDir, manifest);
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const queue = [...entries.map(e => ({ entry: e, base: dir }))];
      while (queue.length > 0) {
        const { entry: fsEntry, base } = queue.shift()!;
        const fullPath = path.join(base, fsEntry.name);
        if (fsEntry.isDirectory()) {
          try {
            const sub = await fs.readdir(fullPath, { withFileTypes: true });
            queue.push(...sub.map(e => ({ entry: e, base: fullPath })));
          } catch {}
        } else if (fsEntry.name === basename) {
          return fullPath;
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Resolve a shorthand spec directory path to an absolute path.
 * Tries: direct path → scan known spec dirs for matching subdirectory name.
 * Returns null if nothing found.
 */
export async function resolveSpecDir(input: string, workingDir: string): Promise<string | null> {
  // 1. Direct path
  const direct = path.resolve(workingDir, input);
  try {
    const stat = await fs.stat(direct);
    if (stat.isDirectory()) return direct;
  } catch {}

  // 2. Scan known spec dirs for a subdirectory matching by name or trailing path
  const dirs = await knownSpecDirs(workingDir);
  const isMultiSegment = input.includes('/');
  const inputName = path.basename(input);
  for (const dir of dirs) {
    // Check if the input matches as a subtree (uses full input, not just basename)
    const candidate = path.join(dir, input);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {}

    // Scan subdirectories recursively for trailing path match
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(entry.parentPath || dir, entry.name);
        if (isMultiSegment) {
          // Multi-segment: only match by trailing path to avoid false positives
          if (fullPath.endsWith('/' + input)) return fullPath;
        } else {
          // Single-segment: match by name or trailing path
          if (entry.name === inputName || fullPath.endsWith('/' + input)) {
            return fullPath;
          }
        }
      }
    } catch {}
  }

  return null;
}

// ── Contextual hints ─────────────────────────────────────────

export interface HintCounts {
  pending: number;
  failed: number;
  untracked: number;
  orphaned: number;
}

/** Build actionable next-step hints based on spec state. Pure function for testability. */
export function buildHints(counts: HintCounts): string[] {
  const hints: string[] = [];
  if (counts.pending > 0) {
    hints.push(`${CMD}forge run --pending "implement"${RESET}     run pending specs`);
    hints.push(`${CMD}forge specs --check${RESET}               auto-resolve implemented specs`);
  }
  if (counts.failed > 0) {
    hints.push(`${CMD}forge run --rerun-failed "fix"${RESET}     rerun failed specs`);
  }
  if (counts.untracked > 0) {
    hints.push(`${CMD}forge specs --add${RESET}                  register untracked specs`);
  }
  if (counts.orphaned > 0) {
    hints.push(`${CMD}forge specs --prune${RESET}                remove orphaned entries`);
  }
  return hints.slice(0, 3);
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
  add?: string | boolean;
  resolve?: string;
  unresolve?: string;
  check?: boolean;
  summary?: boolean;
}

export async function showSpecs(options: ShowSpecsOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();

  // Reconcile from results history if requested
  if (options.reconcile) {
    const count = await reconcileSpecs(workingDir);
    if (count > 0) {
      console.log(`${BOLD}Reconciled ${count} run(s) from DB run history${RESET}\n`);
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

  // Add specs: bare --add registers all untracked, --add <path> registers by path/glob
  if (options.add) {
    let count: number;
    if (typeof options.add === 'string') {
      count = await addSpecs([options.add], workingDir);
    } else {
      const untracked = await findUntrackedSpecs(workingDir);
      count = untracked.length > 0 ? await addSpecs(untracked, workingDir) : 0;
    }
    if (count > 0) {
      console.log(`${BOLD}Added ${count} spec(s) to manifest${RESET}\n`);
    } else {
      console.log(`${DIM}No new specs to add (already tracked or no .md files found).${RESET}\n`);
    }
    return;
  }

  // Resolve spec (mark as passed without running)
  if (options.resolve) {
    const count = await resolveSpecs([options.resolve], workingDir);
    if (count > 0) {
      console.log(`${BOLD}Resolved ${count} spec(s) as passed${RESET}\n`);
    } else {
      console.log(`${DIM}No matching pending spec found.${RESET}\n`);
    }
    return;
  }

  // Unresolve spec (reset to pending)
  if (options.unresolve) {
    const count = await unresolveSpecs([options.unresolve], workingDir);
    if (count > 0) {
      console.log(`${BOLD}Unresolved ${count} spec(s) → pending${RESET}\n`);
    } else {
      console.log(`${DIM}No matching non-pending spec found.${RESET}\n`);
    }
    return;
  }

  // Check pending specs (triage via agent)
  if (options.check) {
    await checkPendingSpecs(workingDir, false);
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
  const untrackedEntries: string[] = (!filterActive || options.untracked)
    ? await findUntrackedSpecs(workingDir)
    : [];

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
    const group = groups.get(dir) ?? [];
    group.push(item);
    groups.set(dir, group);
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

  // Summary mode: directory-level roll-up
  if (options.summary) {
    // Compute max dir name width for alignment
    const dirWidth = Math.max(20, ...sortedGroups.map(([dir]) => (dir === '.' ? '(root)' : dir + '/').length));

    for (const [dir, items] of sortedGroups) {
      const dirLabel = dir === '.' ? '(root)' : dir + '/';
      const groupPassed = items.filter(e => e.status === 'passed').length;
      const groupFailed = items.filter(e => e.status === 'failed').length;
      const groupPending = items.filter(e => e.status === 'pending').length;
      const groupOrphaned = items.filter(e => e.orphaned).length;
      const groupUntracked = items.filter(e => e.untracked).length;
      const groupCost = items.reduce((sum, e) => sum + e.cost, 0);
      const groupDuration = items.reduce((sum, e) => sum + e.duration, 0);

      totalCost += groupCost;
      totalDuration += groupDuration;

      const parts: string[] = [];
      if (groupPassed > 0) parts.push(`\x1b[32m${groupPassed} passed\x1b[0m`);
      if (groupFailed > 0) parts.push(`\x1b[31m${groupFailed} failed\x1b[0m`);
      if (groupPending > 0) parts.push(`${DIM}${groupPending} pending${RESET}`);
      if (groupOrphaned > 0) parts.push(`\x1b[33m${groupOrphaned} orphaned\x1b[0m`);
      if (groupUntracked > 0) parts.push(`${groupUntracked} untracked`);

      const count = items.length;
      const costStr = groupCost > 0 ? `  ${DIM}$${groupCost.toFixed(2)}${RESET}` : '';
      console.log(`  ${BOLD}${dirLabel.padEnd(dirWidth)}${RESET} ${String(count).padStart(3)} spec(s)  ${parts.join(', ')}${costStr}`);
    }

    console.log('');
  } else {
    // Detail mode: individual specs
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

  // Contextual hints (only when no status filter is active)
  if (!filterActive) {
    const orphanedCount = entries.filter(e => e.orphaned).length;
    const hints = buildHints({
      pending,
      failed,
      untracked: untrackedEntries.length,
      orphaned: orphanedCount,
    });
    if (hints.length > 0) {
      console.log('');
      for (const hint of hints) {
        console.log(`  ${DIM}→${RESET} ${hint}`);
      }
    }
  }
}

// ── Check pending specs ──────────────────────────────────────

/** Parse JSON check results from agent response text. Returns null if parsing fails. */
function parseCheckResults(
  text: string,
): Array<{ spec: string; status: string; reason: string }> | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
    || text.match(/(\{[\s\S]*"results"[\s\S]*\})/);
  if (!jsonMatch) return null;

  try {
    const raw = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    const CheckResultsSchema = z.object({
      results: z.array(z.object({
        spec: z.string(),
        status: z.string(),
        reason: z.string(),
      })),
    });
    const validated = CheckResultsSchema.safeParse(raw);
    return validated.success ? validated.data.results : null;
  } catch {
    return null;
  }
}

const CHECK_BATCH_SIZE = 10;

/** Triage pending specs: agent checks codebase and auto-resolves implemented ones. */
export async function checkPendingSpecs(workingDir: string, quiet: boolean): Promise<void> {
  const manifest = await loadManifest(workingDir);
  const pendingEntries = manifest.specs.filter(
    e => e.status === 'pending' || e.status === 'running',
  );

  if (pendingEntries.length === 0) {
    console.log(`${DIM}No pending specs to check.${RESET}`);
    return;
  }

  // Read spec contents
  const specContents: Array<{ key: string; content: string }> = [];
  for (const entry of pendingEntries) {
    const absPath = path.isAbsolute(entry.spec)
      ? entry.spec
      : path.join(workingDir, entry.spec);
    try {
      const content = await fs.readFile(absPath, 'utf-8');
      specContents.push({ key: entry.spec, content });
    } catch {
      // File missing — skip
    }
  }

  if (specContents.length === 0) {
    console.log(`${DIM}No readable pending spec files found.${RESET}`);
    return;
  }

  if (!quiet) {
    console.log(`${BOLD}Checking ${specContents.length} pending spec(s) against codebase...${RESET}\n`);
  }

  const resolved = await resolveConfig(workingDir, {
    defaultModel: 'sonnet',
    defaultMaxTurns: 20,
    defaultMaxBudgetUsd: 5.0,
  });

  // Chunk specs into batches to avoid EPIPE with large prompt sizes
  const batches: Array<typeof specContents> = [];
  for (let i = 0; i < specContents.length; i += CHECK_BATCH_SIZE) {
    batches.push(specContents.slice(i, i + CHECK_BATCH_SIZE));
  }

  const allResults: Array<{ spec: string; status: string; reason: string }> = [];
  let totalDuration = 0;
  let totalCost = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];

    if (batches.length > 1 && !quiet) {
      console.log(`${DIM}[forge]${RESET} Batch ${b + 1}/${batches.length} (${batch.length} specs)...`);
    }

    const specBlock = batch
      .map(s => `### ${s.key}\n\`\`\`markdown\n${s.content}\n\`\`\``)
      .join('\n\n');

    const prompt = `You are checking whether pending specs have already been implemented in the codebase.

For each spec below, read the acceptance criteria carefully, then check the codebase to determine if the criteria are already met.

IMPORTANT tool-use rules:
- Use ONLY Read and Grep tools to inspect the codebase. Do NOT use Bash, Write, or Edit.
- Do NOT use python3, node, or any shell command to build or parse your response.
- Output the JSON result directly as text — do not construct it programmatically.
- Stay focused: check each spec, then output the result. Do not loop or retry.

${specBlock}

After checking all specs, output ONLY a JSON block (no other text) in this exact format:

\`\`\`json
{"results": [{"spec": "<spec key>", "status": "implemented" | "not_implemented", "reason": "<brief explanation>"}]}
\`\`\`

Be thorough: check for the actual implementation, not just file existence. A spec is "implemented" only if ALL its acceptance criteria are met.`;

    let result;
    try {
      result = await runQuery({
        prompt,
        workingDir,
        model: resolved.model,
        maxTurns: resolved.maxTurns,
        maxBudgetUsd: resolved.maxBudgetUsd,
        verbose: false,
        quiet,
        silent: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${DIM}[forge]${RESET} Batch ${b + 1}/${batches.length} failed: ${msg}`);
      console.log(`${DIM}        Skipping batch, continuing...${RESET}`);
      continue;
    }

    totalDuration += result.durationSeconds;
    totalCost += result.costUsd ?? 0;

    const batchResults = parseCheckResults(result.resultText);
    if (!batchResults) {
      console.log(`${DIM}Could not parse agent response for batch ${b + 1}. Raw output:${RESET}`);
      console.log(result.resultText);
      continue;
    }

    allResults.push(...batchResults);
  }

  if (allResults.length === 0) {
    console.log(`${DIM}No parseable results from agent.${RESET}`);
    printRunSummary({ durationSeconds: totalDuration, costUsd: totalCost });
    return;
  }

  // Display results and auto-resolve implemented specs
  const toResolve: string[] = [];
  for (const r of allResults) {
    const statusColor = r.status === 'implemented' ? '\x1b[32m' : DIM;
    const label = r.status === 'implemented' ? 'implemented' : 'not implemented';
    console.log(`  ${statusColor}${label.padEnd(16)}${RESET} ${r.spec}`);
    if (r.reason) {
      console.log(`  ${DIM}${' '.repeat(16)} ${r.reason}${RESET}`);
    }
    if (r.status === 'implemented') {
      toResolve.push(r.spec);
    }
  }

  if (toResolve.length > 0) {
    // Map agent-returned keys back to canonical manifest keys
    const canonicalKeys = toResolve.map(agentKey => {
      const match = specContents.find(s =>
        s.key === agentKey
        || path.basename(s.key) === agentKey
        || s.key.endsWith('/' + agentKey)
        || path.basename(s.key) === path.basename(agentKey)
      );
      return match ? match.key : agentKey;
    });
    const count = await resolveSpecs(canonicalKeys, workingDir);
    console.log(`\n${BOLD}Resolved ${count} spec(s) as passed${RESET}`);
  } else {
    console.log(`\n${DIM}No specs were fully implemented.${RESET}`);
  }

  printRunSummary({ durationSeconds: totalDuration, costUsd: totalCost });
}
