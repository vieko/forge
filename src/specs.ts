import type { SpecManifest, SpecEntry, SpecRun } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DIM, RESET, BOLD } from './display.js';

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

// ── showSpecs command ────────────────────────────────────────

export interface ShowSpecsOptions {
  cwd?: string;
  pending?: boolean;
  failed?: boolean;
  passed?: boolean;
  orphaned?: boolean;
  untracked?: boolean;
  reconcile?: boolean;
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

  // Print tracked entries
  for (const e of entries) {
    const color = statusColor(e.status);
    const statusPad = e.status.padEnd(10);
    const runLabel = e.runs === 1 ? '1 run ' : `${e.runs} runs`;
    const costStr = e.cost > 0 ? `$${e.cost.toFixed(2)}` : '';
    const durStr = e.duration > 0 ? `${Math.round(e.duration)}s` : '';
    const suffix = e.orphaned ? `  ${DIM}(file missing)${RESET}` : '';

    if (e.runs > 0) {
      console.log(`  ${color}${statusPad}${RESET} ${e.spec.padEnd(35)} ${runLabel.padEnd(8)} ${costStr.padStart(7)}   ${durStr.padStart(5)}${suffix}`);
    } else {
      console.log(`  ${color}${statusPad}${RESET} ${e.spec.padEnd(35)} ${DIM}${runLabel}${RESET}${suffix}`);
    }
  }

  // Print untracked entries
  if (untrackedEntries.length > 0 && (!filterActive || options.untracked)) {
    if (entries.length > 0) console.log('');
    for (const u of untrackedEntries.sort()) {
      console.log(`  ${DIM}untracked${RESET}  ${u}`);
    }
  }

  // Summary
  const total = manifest.specs.length;
  const passed = manifest.specs.filter(e => e.status === 'passed').length;
  const failed = manifest.specs.filter(e => e.status === 'failed').length;
  const pending = manifest.specs.filter(e => e.status === 'pending').length;

  if (!filterActive && total > 0) {
    console.log(`\n${DIM}${total} spec(s): ${RESET}${passed > 0 ? `\x1b[32m${passed} passed\x1b[0m` : ''}${passed > 0 && (failed > 0 || pending > 0) ? ', ' : ''}${failed > 0 ? `\x1b[31m${failed} failed\x1b[0m` : ''}${failed > 0 && pending > 0 ? ', ' : ''}${pending > 0 ? `${DIM}${pending} pending${RESET}` : ''}${untrackedEntries.length > 0 ? `, ${untrackedEntries.length} untracked` : ''}`);
  }
}
