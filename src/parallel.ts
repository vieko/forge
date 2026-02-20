import type { ForgeOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ForgeError } from './utils.js';
import { DIM, RESET, BOLD, CMD, AGENT_VERBS, SPINNER_FRAMES, formatElapsed, showBanner } from './display.js';
import { runSingleSpec, type BatchResult } from './run.js';
import { loadSpecDeps, topoSort, hasDependencies, type SpecDep, type DepLevel } from './deps.js';
import { withManifestLock, findOrCreateEntry, specKey, loadManifest, resolveSpecFile, resolveSpecDir } from './specs.js';
import { resolveWorkingDir } from './utils.js';

// Worker pool: runs tasks with bounded concurrency
async function workerPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// Multi-line spinner display for parallel spec execution
type SpecStatus = 'waiting' | 'running' | 'success' | 'failed';

interface SpecState {
  name: string;
  status: SpecStatus;
  startedAt?: number;
  duration?: number;
  error?: string;
  detail?: string;
}

function createSpecDisplay(specFiles: string[]) {
  const states: SpecState[] = specFiles.map(name => ({ name, status: 'waiting' }));
  const nameWidth = Math.max(35, ...specFiles.map(f => f.length));
  let frameIndex = 0;
  let linesDrawn = 0;
  let finished = false;

  function render() {
    const cols = process.stdout.columns || 80;

    // Move cursor up to overwrite previous render (cursor is ON last line, not below it)
    if (linesDrawn > 0) {
      process.stdout.write(`\x1b[${linesDrawn}A`);
    }

    const prefixWidth = nameWidth + 14; // "X " + name + " elapsed(10)"
    const detailMax = Math.max(0, cols - prefixWidth - 4); // 4 for "  " + padding

    const lines: string[] = [];

    // Header line with rotating verb (every ~12 frames ≈ 1s)
    if (!finished) {
      const verb = AGENT_VERBS[Math.floor(frameIndex / 12) % AGENT_VERBS.length];
      lines.push(`${CMD}${verb}...${RESET}`);
    } else {
      lines.push('');
    }

    for (const s of states) {
      const padName = s.name.padEnd(nameWidth);
      switch (s.status) {
        case 'waiting':
          lines.push(`  ${padName} ${DIM}waiting${RESET}`);
          break;
        case 'running': {
          const elapsed = formatElapsed(Date.now() - s.startedAt!);
          const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
          const detail = s.detail && detailMax > 5
            ? `  ${DIM}${s.detail.substring(0, detailMax)}${RESET}`
            : '';
          lines.push(`${CMD}${frame}${RESET} ${padName} ${elapsed}${detail}`);
          break;
        }
        case 'success':
          lines.push(`\x1b[32m+\x1b[0m ${padName} \x1b[32m${formatElapsed(s.duration! * 1000)}\x1b[0m`);
          break;
        case 'failed': {
          const errMax = Math.max(0, cols - prefixWidth - 10); // "failed" + spacing
          const errDetail = s.error && errMax > 5
            ? `  ${DIM}${s.error.substring(0, errMax)}${RESET}`
            : '';
          lines.push(`\x1b[31mx\x1b[0m ${padName} \x1b[31mfailed\x1b[0m${errDetail}`);
          break;
        }
      }
    }

    // Clear and write each line; no trailing \n on last line to prevent scroll
    for (let i = 0; i < lines.length; i++) {
      const eol = i < lines.length - 1 ? '\n' : '';
      process.stdout.write(`\x1b[2K\r${lines[i]}${eol}`);
    }
    linesDrawn = lines.length - 1; // cursor is ON last line, move up N-1 to reach first
    frameIndex++;
  }

  const interval = setInterval(render, 80);

  return {
    start(index: number) {
      states[index].status = 'running';
      states[index].startedAt = Date.now();
    },
    activity(index: number, detail: string) {
      states[index].detail = detail;
    },
    done(index: number, duration: number) {
      states[index].status = 'success';
      states[index].duration = duration;
      states[index].detail = undefined;
    },
    fail(index: number, error: string) {
      states[index].status = 'failed';
      states[index].error = error;
      states[index].detail = undefined;
    },
    stop() {
      finished = true;
      clearInterval(interval);
      render(); // Final render
      process.stdout.write('\n'); // Move below display for subsequent output
    },
  };
}

// Auto-detect concurrency based on available memory and CPU
export function autoDetectConcurrency(): number {
  const freeMem = os.freemem();
  const memBased = Math.floor(freeMem / (2 * 1024 * 1024 * 1024)); // 2GB per worker
  const cpuBased = Math.min(os.cpus().length, 5);
  return Math.max(1, Math.min(memBased, cpuBased));
}

// ── Progress Tracker ─────────────────────────────────────────

interface ProgressSpec {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  duration?: number;
  cost?: number;
}

function createProgressTracker(specNames: string[], quiet?: boolean) {
  const items: ProgressSpec[] = specNames.map(name => ({ name, status: 'pending' }));
  const nameWidth = Math.max(30, ...specNames.map(n => n.length));

  function formatLine(item: ProgressSpec): string {
    const padName = item.name.padEnd(nameWidth);
    switch (item.status) {
      case 'pending':
        return `  ${DIM}- ${padName}${RESET}`;
      case 'running':
        return `  ${CMD}> ${padName}${RESET}`;
      case 'success': {
        const dur = item.duration !== undefined ? `${item.duration.toFixed(1).padStart(6)}s` : '';
        const cost = item.cost !== undefined ? `  $${item.cost.toFixed(2)}` : '';
        return `  \x1b[32m+ ${padName}\x1b[0m ${dur}${cost}`;
      }
      case 'failed': {
        const dur = item.duration !== undefined ? `${item.duration.toFixed(1).padStart(6)}s` : '';
        const cost = item.cost !== undefined ? `  $${item.cost.toFixed(2)}` : '';
        return `  \x1b[31mx ${padName}\x1b[0m ${dur}${cost}`;
      }
    }
  }

  function printCheckpoint(): void {
    if (quiet) return;
    console.log('');
    for (const item of items) {
      console.log(formatLine(item));
    }
    console.log('');
  }

  return {
    /** Mark spec as running and print checkpoint with leading divider */
    start(index: number): void {
      items[index].status = 'running';
      if (quiet) return;
      console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
      printCheckpoint();
      console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    },
    /** Mark spec as succeeded */
    done(index: number, duration: number, cost?: number): void {
      items[index].status = 'success';
      items[index].duration = duration;
      items[index].cost = cost;
    },
    /** Mark spec as failed */
    fail(index: number, duration: number, cost?: number): void {
      items[index].status = 'failed';
      items[index].duration = duration;
      items[index].cost = cost;
    },
    /** Print final checkpoint (no surrounding dividers — batch summary adds its own) */
    printFinal(): void {
      if (quiet) return;
      console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
      console.log('');
      for (const item of items) {
        console.log(formatLine(item));
      }
      console.log('');
    },
    /** Bulk-update results from a parallel phase (for dependency-graph integration) */
    applyResults(results: BatchResult[], specIndexMap: Map<string, number>): void {
      for (const r of results) {
        const idx = specIndexMap.get(r.spec);
        if (idx === undefined) continue;
        if (r.status === 'success') {
          items[idx].status = 'success';
          items[idx].duration = r.duration;
          items[idx].cost = r.cost;
        } else {
          items[idx].status = 'failed';
          items[idx].duration = r.duration;
          items[idx].cost = r.cost;
        }
      }
    },
    /** Mark a set of specs as running (for parallel phases) */
    markRunning(indices: number[]): void {
      for (const idx of indices) {
        items[idx].status = 'running';
      }
    },
  };
}

// Run specs sequentially
async function runSpecsSequential(
  specs: Array<{ name: string; path: string }>,
  options: ForgeOptions,
  runId: string,
  label?: string,
  tracker?: ReturnType<typeof createProgressTracker>,
  trackerIndices?: number[],
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  const { quiet } = options;
  const useTracker = tracker && trackerIndices && trackerIndices.length === specs.length;

  for (let i = 0; i < specs.length; i++) {
    const { name: specFile, path: specFilePath } = specs[i];

    if (useTracker) {
      tracker.start(trackerIndices[i]);
    } else if (!quiet) {
      console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
      console.log(`Running spec ${i + 1}/${specs.length}${label ? ` (${label})` : ''}: ${BOLD}${specFile}${RESET}`);
      console.log(`${DIM}${'─'.repeat(60)}${RESET}\n`);
    }

    const startTime = Date.now();
    try {
      const specContent = await fs.readFile(specFilePath, 'utf-8');

      const result = await runSingleSpec({
        ...options,
        specPath: specFilePath,
        specContent,
        specDir: undefined,
        _runId: runId,
        _specLabel: `${i + 1}/${specs.length}`,
      });

      const duration = (Date.now() - startTime) / 1000;
      const cost = result.costUsd;
      results.push({ spec: specFile, status: 'success', cost, duration });
      if (useTracker) tracker.done(trackerIndices[i], duration, cost);
    } catch (err) {
      const duration = (Date.now() - startTime) / 1000;
      const cost = err instanceof ForgeError ? err.result?.costUsd : undefined;
      results.push({
        spec: specFile,
        status: `failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        cost,
        duration
      });
      if (useTracker) tracker.fail(trackerIndices[i], duration, cost);

      if (!quiet) {
        console.error(`\nSpec ${specFile} failed:`, err instanceof Error ? err.message : err);
        console.log('Continuing with next spec...\n');
      }
    }
  }

  return results;
}

// Run specs in parallel with a spinner display
async function runSpecsParallel(
  specs: Array<{ name: string; path: string }>,
  options: ForgeOptions,
  concurrency: number,
  runId: string,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  const names = specs.map(s => s.name);
  const display = createSpecDisplay(names);

  await workerPool(names, concurrency, async (specFile, i) => {
    const specFilePath = specs[i].path;
    display.start(i);

    const startTime = Date.now();
    try {
      const specContent = await fs.readFile(specFilePath, 'utf-8');

      const result = await runSingleSpec({
        ...options,
        specPath: specFilePath,
        specContent,
        specDir: undefined,
        parallel: undefined,
        quiet: true,
        _silent: true,
        _onActivity: (detail) => display.activity(i, detail),
        _runId: runId,
      });

      const duration = (Date.now() - startTime) / 1000;
      display.done(i, duration);
      results.push({ spec: specFile, status: 'success', cost: result.costUsd, duration });
    } catch (err) {
      const duration = (Date.now() - startTime) / 1000;
      const cost = err instanceof ForgeError ? err.result?.costUsd : undefined;
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      display.fail(i, errMsg);
      results.push({
        spec: specFile,
        status: `failed: ${errMsg}`,
        cost,
        duration
      });
    }
  });

  display.stop();
  return results;
}

// Run a batch of spec files with dependency-aware execution
async function runSpecBatch(
  specFilePaths: string[],
  specFileNames: string[],
  options: ForgeOptions,
  concurrency: number,
  runId: string,
  satisfiedDeps?: Set<string>,
): Promise<{ results: BatchResult[]; hasTracker: boolean }> {
  const results: BatchResult[] = [];
  const { quiet, parallel, sequentialFirst = 0 } = options;

  // Load dependency metadata from spec frontmatter
  const specDeps = await loadSpecDeps(specFilePaths, specFileNames);

  // Strip already-satisfied deps (e.g. passed specs filtered from the batch)
  if (satisfiedDeps && satisfiedDeps.size > 0) {
    for (const spec of specDeps) {
      spec.depends = spec.depends.filter(d => !satisfiedDeps.has(d));
    }
  }

  const useDeps = hasDependencies(specDeps);

  // Register all specs in the manifest as 'running' before execution
  const batchWorkingDir = await resolveWorkingDir(options.cwd);
  await withManifestLock(batchWorkingDir, (manifest) => {
    for (const specFilePath of specFilePaths) {
      const key = specKey(specFilePath, batchWorkingDir);
      const entry = findOrCreateEntry(manifest, key, 'file');
      entry.status = 'running';
      entry.updatedAt = new Date().toISOString();
    }
  });

  // Dependency-aware execution: topological levels
  if (useDeps && parallel) {
    const levels = topoSort(specDeps);

    // Flatten all spec names across levels for the tracker
    const allSpecNames: string[] = [];
    const specIndexMap = new Map<string, number>();
    for (const level of levels) {
      for (const s of level.specs) {
        specIndexMap.set(s.name, allSpecNames.length);
        allSpecNames.push(s.name);
      }
    }

    const tracker = createProgressTracker(allSpecNames, quiet ?? false);

    if (!quiet) {
      console.log(`${DIM}[dependency graph: ${levels.length} level(s)]${RESET}`);
    }

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      const levelSpecs = level.specs.map(s => ({ name: s.name, path: s.path }));
      const levelIndices = levelSpecs.map(s => specIndexMap.get(s.name)!);

      if (levelSpecs.length === 1) {
        // Single spec in level — run sequentially with tracker
        const levelResults = await runSpecsSequential(
          levelSpecs, options, runId,
          `level ${i + 1}/${levels.length}`,
          tracker, levelIndices,
        );
        results.push(...levelResults);
      } else {
        // Multiple specs in level — run in parallel
        tracker.markRunning(levelIndices);
        if (!quiet) {
          console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
          console.log(`Level ${i + 1}/${levels.length}: ${BOLD}${levelSpecs.length} specs${RESET} ${DIM}(parallel)${RESET}`);
          console.log(`${DIM}${'─'.repeat(60)}${RESET}\n`);
        }
        const levelResults = await runSpecsParallel(levelSpecs, options, concurrency, runId);
        tracker.applyResults(levelResults, specIndexMap);
        results.push(...levelResults);
      }
    }

    // Final checkpoint after all levels
    tracker.printFinal();

    return { results, hasTracker: true };
  }

  // Default behavior: sequential-first + parallel split
  const seqCount = parallel ? Math.min(sequentialFirst, specFileNames.length) : specFileNames.length;
  const seqSpecs = specFileNames.slice(0, seqCount).map((name, i) => ({
    name, path: specFilePaths[i],
  }));
  const parSpecs = specFileNames.slice(seqCount).map((name, i) => ({
    name, path: specFilePaths[seqCount + i],
  }));

  // Create tracker for sequential-only batches (more than 1 spec)
  const useSequentialTracker = !parallel && specFileNames.length > 1;
  const tracker = useSequentialTracker
    ? createProgressTracker(specFileNames, quiet ?? false)
    : undefined;

  // Sequential phase
  if (seqSpecs.length > 0) {
    const label = parSpecs.length > 0 ? 'sequential' : undefined;
    const seqIndices = seqSpecs.map((_, i) => i);
    const seqResults = await runSpecsSequential(seqSpecs, options, runId, label, tracker, tracker ? seqIndices : undefined);
    results.push(...seqResults);
  }

  // Parallel phase
  if (parSpecs.length > 0) {
    const parResults = await runSpecsParallel(parSpecs, options, concurrency, runId);
    results.push(...parResults);
  }

  // Final checkpoint for sequential-only batches
  if (tracker) {
    tracker.printFinal();
  }

  return { results, hasTracker: !!tracker };
}

// Find failed specs from latest batch in .forge/results/
async function findFailedSpecs(workingDir: string): Promise<{ runId: string; specPaths: string[] }> {
  const resultsBase = path.join(workingDir, '.forge', 'results');

  let dirs: string[];
  try {
    dirs = (await fs.readdir(resultsBase)).sort().reverse(); // newest first
  } catch {
    throw new Error('No results found in .forge/results/');
  }

  // Single pass: read all summaries, find latest runId, collect failures
  const summaries: ForgeResult[] = [];
  let latestRunId: string | undefined;

  for (const dir of dirs) {
    try {
      const summary: ForgeResult = JSON.parse(
        await fs.readFile(path.join(resultsBase, dir, 'summary.json'), 'utf-8')
      );
      summaries.push(summary);
      // First result with a runId is the latest (dirs sorted newest first)
      if (!latestRunId && summary.runId) {
        latestRunId = summary.runId;
      }
    } catch { continue; }
  }

  if (!latestRunId) {
    throw new Error('No batch runs found (no runId in results). Run with --spec-dir first.');
  }

  // Filter failures from the same batch
  const failedPaths = summaries
    .filter(s => s.runId === latestRunId && s.status !== 'success' && s.specPath)
    .map(s => s.specPath!);

  return { runId: latestRunId, specPaths: failedPaths };
}

// Find pending specs from the manifest
async function findPendingSpecs(workingDir: string): Promise<string[]> {
  const manifest = await loadManifest(workingDir);
  const pending: string[] = [];

  for (const entry of manifest.specs) {
    if (entry.status !== 'pending' && entry.status !== 'running') continue;
    if (entry.source === 'pipe') continue;

    const absPath = path.isAbsolute(entry.spec)
      ? entry.spec
      : path.resolve(workingDir, entry.spec);

    // Verify the file still exists
    try {
      await fs.access(absPath);
      pending.push(absPath);
    } catch {}
  }

  return pending;
}

// Print batch summary with cost tracking and next-step hint
// When hasTracker is true, the progress tracker already printed per-spec results — skip the duplicate listing.
function printBatchSummary(
  results: BatchResult[],
  wallClockDuration: number,
  parallel: boolean,
  quiet: boolean,
  specDir?: string,
  hasTracker?: boolean,
): void {
  const totalSpecDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const totalCost = results.reduce((sum, r) => sum + (r.cost || 0), 0);

  if (!quiet || parallel) {
    const successCount = results.filter(r => r.status === 'success').length;
    const allPassed = successCount === results.length;

    if (hasTracker) {
      // Tracker already printed per-spec results — just show aggregates
      console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    } else {
      console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
      console.log(`${BOLD}SPEC BATCH SUMMARY${RESET}`);
      console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
      results.forEach(r => {
        const icon = r.status === 'success' ? '\x1b[32m+\x1b[0m' : '\x1b[31mx\x1b[0m';
        const cost = r.cost !== undefined ? `$${r.cost.toFixed(2)}` : '   -';
        console.log(`  ${icon} ${r.spec.padEnd(30)} ${r.duration.toFixed(1).padStart(6)}s  ${cost}`);
      });
      console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    }

    console.log(`  Wall-clock: ${BOLD}${wallClockDuration.toFixed(1)}s${RESET}`);
    if (parallel) {
      console.log(`  Spec total: ${totalSpecDuration.toFixed(1)}s`);
    }
    console.log(`  Cost:       ${BOLD}$${totalCost.toFixed(2)}${RESET}`);
    console.log(`  Result:     ${allPassed ? '\x1b[32m' : '\x1b[33m'}${successCount}/${results.length} successful\x1b[0m`);

    // Next-step hint
    if (allPassed && specDir) {
      console.log(`\n  ${DIM}Next step:${RESET}`);
      console.log(`    forge audit ${specDir} "verify implementation"`);
    } else if (!allPassed) {
      console.log(`\n  ${DIM}Next step:${RESET}`);
      console.log(`    forge run --rerun-failed -P "fix failures"`);
    }
  }
}

/** Filter out spec filenames whose manifest entry is already 'passed'. */
export async function filterPassedSpecs(
  specFileNames: string[],
  specDir: string,
  workingDir: string,
): Promise<{ remaining: string[]; skipped: number; skippedNames: Set<string> }> {
  const manifest = await loadManifest(workingDir);
  const passedKeys = new Set(
    manifest.specs
      .filter(e => e.status === 'passed')
      .map(e => e.spec),
  );

  const skippedNames = new Set<string>();
  const remaining = specFileNames.filter(f => {
    const absPath = path.join(specDir, f);
    const key = specKey(absPath, workingDir);
    if (passedKeys.has(key)) {
      skippedNames.add(f);
      return false;
    }
    return true;
  });

  return { remaining, skipped: skippedNames.size, skippedNames };
}

// Main entry point - handles single spec or spec directory
export async function runForge(options: ForgeOptions): Promise<void> {
  const { specDir, specPath, quiet, parallel, sequentialFirst = 0, rerunFailed, pendingOnly, force } = options;

  if (!quiet) {
    showBanner('DEFINE OUTCOMES ▲ VERIFY RESULTS');
  }

  // Resolve working directory early — used by multiple code paths
  const workingDir = await resolveWorkingDir(options.cwd);

  // Resolve concurrency: use provided value or auto-detect
  const concurrency = options.concurrency ?? autoDetectConcurrency();

  // Generate a unique run ID for batch grouping
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;

  // Rerun failed specs from latest batch
  if (rerunFailed) {
    const { runId: prevRunId, specPaths: failedPaths } = await findFailedSpecs(workingDir);

    if (failedPaths.length === 0) {
      console.log('No failed specs found in latest batch. All passed!');
      return;
    }

    const failedNames = failedPaths.map(p => path.basename(p));
    if (!quiet) {
      console.log(`Rerunning ${BOLD}${failedPaths.length}${RESET} failed spec(s) from batch ${DIM}${prevRunId.substring(0, 8)}${RESET}`);
      if (parallel) {
        console.log(`${DIM}[parallel (concurrency: ${options.concurrency ? concurrency : `auto: ${concurrency}`})]${RESET}`);
      } else {
        console.log(`${DIM}[sequential]${RESET}`);
      }
    }

    const wallClockStart = Date.now();
    const { results, hasTracker } = await runSpecBatch(failedPaths, failedNames, options, concurrency, runId);
    const wallClockDuration = (Date.now() - wallClockStart) / 1000;

    printBatchSummary(results, wallClockDuration, parallel ?? false, quiet ?? false, undefined, hasTracker);
    return;
  }

  // Run only pending specs from the manifest
  if (pendingOnly) {
    const pendingPaths = await findPendingSpecs(workingDir);

    if (pendingPaths.length === 0) {
      console.log('No pending specs found in manifest. All done!');
      return;
    }

    const pendingNames = pendingPaths.map(p => path.basename(p));
    if (!quiet) {
      console.log(`Running ${BOLD}${pendingPaths.length}${RESET} pending spec(s)`);
      if (parallel) {
        console.log(`${DIM}[parallel (concurrency: ${options.concurrency ? concurrency : `auto: ${concurrency}`})]${RESET}`);
      } else {
        console.log(`${DIM}[sequential]${RESET}`);
      }
    }

    const wallClockStart = Date.now();
    const { results, hasTracker } = await runSpecBatch(pendingPaths, pendingNames, options, concurrency, runId);
    const wallClockDuration = (Date.now() - wallClockStart) / 1000;

    printBatchSummary(results, wallClockDuration, parallel ?? false, quiet ?? false, undefined, hasTracker);
    return;
  }

  // If spec directory provided, run each spec
  if (specDir) {
    const resolvedDir = await resolveSpecDir(specDir, workingDir) ?? path.resolve(specDir);
    if (!quiet && resolvedDir !== path.resolve(specDir)) {
      console.log(`${DIM}[forge]${RESET} Resolved: ${specDir} → ${path.relative(workingDir, resolvedDir) || resolvedDir}\n`);
    }

    let files: string[];
    try {
      files = await fs.readdir(resolvedDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Spec directory not found: ${resolvedDir}`);
      }
      throw err;
    }

    const allSpecFiles = files
      .filter(f => f.endsWith('.md'))
      .sort(); // Alphabetical order for predictable execution

    if (allSpecFiles.length === 0) {
      throw new Error(`No .md files found in ${resolvedDir}`);
    }

    // Filter out already-passed specs unless --force
    let specFiles = allSpecFiles;
    let skippedCount = 0;
    let skippedNames = new Set<string>();
    if (!force) {
      const filtered = await filterPassedSpecs(allSpecFiles, resolvedDir, workingDir);
      specFiles = filtered.remaining;
      skippedCount = filtered.skipped;
      skippedNames = filtered.skippedNames;
    }

    if (specFiles.length === 0) {
      console.log(`All ${allSpecFiles.length} specs already passed. Use ${BOLD}--force${RESET} to re-run.`);
      return;
    }

    if (!quiet) {
      const mode = parallel
        ? `parallel (concurrency: ${options.concurrency ? concurrency : `auto: ${concurrency}`})`
        : 'sequential';
      console.log(`Found ${BOLD}${specFiles.length}${RESET} specs in ${DIM}${resolvedDir}${RESET}`);
      if (skippedCount > 0) {
        console.log(`${DIM}[skipped ${skippedCount} already passed — use --force to re-run]${RESET}`);
      }
      console.log(`${DIM}[${mode}]${RESET}`);
      if (parallel && sequentialFirst > 0) {
        console.log(`\nSequential-first: ${Math.min(sequentialFirst, specFiles.length)} spec(s) run before parallel phase`);
      }
    }

    const specFilePaths = specFiles.map(f => path.join(resolvedDir, f));

    const wallClockStart = Date.now();
    const { results, hasTracker } = await runSpecBatch(specFilePaths, specFiles, options, concurrency, runId, skippedNames);
    const wallClockDuration = (Date.now() - wallClockStart) / 1000;

    const displayDir = path.relative(workingDir, resolvedDir) || resolvedDir;
    printBatchSummary(results, wallClockDuration, parallel ?? false, quiet ?? false, displayDir, hasTracker);

    return;
  }

  // Auto-detect: if prompt looks like a file path to an existing .md file, treat as --spec
  const effectiveOptions = { ...options };
  if (!effectiveOptions.specPath && !effectiveOptions.specDir
      && effectiveOptions.prompt.endsWith('.md') && !effectiveOptions.prompt.includes(' ')) {
    const resolved = await resolveSpecFile(effectiveOptions.prompt, workingDir);
    if (resolved) {
      effectiveOptions.specPath = resolved;
      const display = resolved !== path.resolve(workingDir, effectiveOptions.prompt)
        ? `${effectiveOptions.prompt} → ${path.relative(workingDir, resolved)}`
        : path.relative(workingDir, resolved) || resolved;
      effectiveOptions.prompt = 'implement this specification';
      if (!quiet) {
        console.log(`${DIM}[forge]${RESET} Detected spec file: ${DIM}${display}${RESET}\n`);
      }
    }
  }

  // Resolve --spec shorthand if path doesn't exist directly
  if (effectiveOptions.specPath) {
    try {
      await fs.access(effectiveOptions.specPath);
    } catch {
      const resolved = await resolveSpecFile(effectiveOptions.specPath, workingDir);
      if (resolved) {
        if (!quiet) {
          console.log(`${DIM}[forge]${RESET} Resolved: ${effectiveOptions.specPath} → ${path.relative(workingDir, resolved) || resolved}\n`);
        }
        effectiveOptions.specPath = resolved;
      }
    }
  }

  // Single spec or no spec - run directly
  await runSingleSpec({ ...effectiveOptions, _runId: runId });
}
