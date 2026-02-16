import type { ForgeOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ForgeError } from './utils.js';
import { DIM, RESET, BOLD, CMD, AGENT_VERBS, SPINNER_FRAMES, formatElapsed, showBanner } from './display.js';
import { runSingleSpec, type BatchResult } from './run.js';
import { loadSpecDeps, topoSort, hasDependencies, type SpecDep, type DepLevel } from './deps.js';
import { withManifestLock, findOrCreateEntry, specKey } from './specs.js';
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
          lines.push(`\x1b[32m✓\x1b[0m ${padName} \x1b[32m${formatElapsed(s.duration! * 1000)}\x1b[0m`);
          break;
        case 'failed': {
          const errMax = Math.max(0, cols - prefixWidth - 10); // "failed" + spacing
          const errDetail = s.error && errMax > 5
            ? `  ${DIM}${s.error.substring(0, errMax)}${RESET}`
            : '';
          lines.push(`\x1b[31m✗\x1b[0m ${padName} \x1b[31mfailed\x1b[0m${errDetail}`);
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

// Run specs sequentially
async function runSpecsSequential(
  specs: Array<{ name: string; path: string }>,
  options: ForgeOptions,
  runId: string,
  label?: string,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  const { quiet } = options;

  for (let i = 0; i < specs.length; i++) {
    const { name: specFile, path: specFilePath } = specs[i];

    if (!quiet) {
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
      });

      const duration = (Date.now() - startTime) / 1000;
      results.push({ spec: specFile, status: 'success', cost: result.costUsd, duration });
    } catch (err) {
      const duration = (Date.now() - startTime) / 1000;
      const cost = err instanceof ForgeError ? err.result?.costUsd : undefined;
      results.push({
        spec: specFile,
        status: `failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        cost,
        duration
      });

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
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  const { quiet, parallel, sequentialFirst = 0 } = options;

  // Load dependency metadata from spec frontmatter
  const specDeps = await loadSpecDeps(specFilePaths, specFileNames);
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

    if (!quiet) {
      console.log(`${DIM}[dependency graph: ${levels.length} level(s)]${RESET}\n`);
      for (let i = 0; i < levels.length; i++) {
        const names = levels[i].specs.map(s => s.name).join(', ');
        console.log(`  ${DIM}Level ${i + 1}:${RESET} ${names}`);
      }
      console.log('');
    }

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      const levelSpecs = level.specs.map(s => ({ name: s.name, path: s.path }));

      if (levelSpecs.length === 1) {
        // Single spec in level — run sequentially (no spinner overhead)
        const levelResults = await runSpecsSequential(
          levelSpecs, options, runId,
          `level ${i + 1}/${levels.length}`,
        );
        results.push(...levelResults);
      } else {
        // Multiple specs in level — run in parallel
        if (!quiet) {
          console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
          console.log(`Level ${i + 1}/${levels.length}: ${BOLD}${levelSpecs.length} specs${RESET} ${DIM}(parallel)${RESET}`);
          console.log(`${DIM}${'─'.repeat(60)}${RESET}\n`);
        }
        const levelResults = await runSpecsParallel(levelSpecs, options, concurrency, runId);
        results.push(...levelResults);
      }
    }

    return results;
  }

  // Default behavior: sequential-first + parallel split
  const seqCount = parallel ? Math.min(sequentialFirst, specFileNames.length) : specFileNames.length;
  const seqSpecs = specFileNames.slice(0, seqCount).map((name, i) => ({
    name, path: specFilePaths[i],
  }));
  const parSpecs = specFileNames.slice(seqCount).map((name, i) => ({
    name, path: specFilePaths[seqCount + i],
  }));

  // Sequential phase
  if (seqSpecs.length > 0) {
    const label = parSpecs.length > 0 ? 'sequential' : undefined;
    const seqResults = await runSpecsSequential(seqSpecs, options, runId, label);
    results.push(...seqResults);
  }

  // Parallel phase
  if (parSpecs.length > 0) {
    const parResults = await runSpecsParallel(parSpecs, options, concurrency, runId);
    results.push(...parResults);
  }

  return results;
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

// Print batch summary with cost tracking
function printBatchSummary(
  results: BatchResult[],
  wallClockDuration: number,
  parallel: boolean,
  quiet: boolean,
): void {
  const totalSpecDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const totalCost = results.reduce((sum, r) => sum + (r.cost || 0), 0);

  if (!quiet || parallel) {
    const successCount = results.filter(r => r.status === 'success').length;
    console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`${BOLD}SPEC BATCH SUMMARY${RESET}`);
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    results.forEach(r => {
      const icon = r.status === 'success' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const cost = r.cost !== undefined ? `$${r.cost.toFixed(2)}` : '   -';
      console.log(`  ${icon} ${r.spec.padEnd(30)} ${r.duration.toFixed(1).padStart(6)}s  ${cost}`);
    });
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`  Wall-clock: ${BOLD}${wallClockDuration.toFixed(1)}s${RESET}`);
    if (parallel) {
      console.log(`  Spec total: ${totalSpecDuration.toFixed(1)}s`);
    }
    console.log(`  Cost:       ${BOLD}$${totalCost.toFixed(2)}${RESET}`);
    console.log(`  Result:     ${successCount === results.length ? '\x1b[32m' : '\x1b[33m'}${successCount}/${results.length} successful\x1b[0m`);
  }
}

// Main entry point - handles single spec or spec directory
export async function runForge(options: ForgeOptions): Promise<void> {
  const { specDir, specPath, quiet, parallel, sequentialFirst = 0, rerunFailed } = options;

  if (!quiet) {
    showBanner('DEFINE OUTCOMES ▲ VERIFY RESULTS.');
  }

  // Resolve concurrency: use provided value or auto-detect
  const concurrency = options.concurrency ?? autoDetectConcurrency();

  // Generate a unique run ID for batch grouping
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;

  // Rerun failed specs from latest batch
  if (rerunFailed) {
    const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
    const { runId: prevRunId, specPaths: failedPaths } = await findFailedSpecs(workingDir);

    if (failedPaths.length === 0) {
      console.log('No failed specs found in latest batch. All passed!');
      return;
    }

    const failedNames = failedPaths.map(p => path.basename(p));
    if (!quiet) {
      console.log(`Rerunning ${BOLD}${failedPaths.length}${RESET} failed spec(s) from batch ${DIM}${prevRunId.substring(0, 8)}${RESET}`);
      if (!parallel) {
        failedNames.forEach((f, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${f}`));
      }
      if (parallel) {
        console.log(`${DIM}[parallel (concurrency: ${options.concurrency ? concurrency : `auto: ${concurrency}`})]${RESET}`);
      }
      console.log('');
    }

    const wallClockStart = Date.now();
    const results = await runSpecBatch(failedPaths, failedNames, options, concurrency, runId);
    const wallClockDuration = (Date.now() - wallClockStart) / 1000;

    printBatchSummary(results, wallClockDuration, parallel ?? false, quiet ?? false);
    return;
  }

  // If spec directory provided, run each spec
  if (specDir) {
    const resolvedDir = path.resolve(specDir);

    try {
      const files = await fs.readdir(resolvedDir);
      const specFiles = files
        .filter(f => f.endsWith('.md'))
        .sort(); // Alphabetical order for predictable execution

      if (specFiles.length === 0) {
        throw new Error(`No .md files found in ${resolvedDir}`);
      }

      if (!quiet) {
        const mode = parallel
          ? `parallel (concurrency: ${options.concurrency ? concurrency : `auto: ${concurrency}`})`
          : 'sequential';
        console.log(`Found ${BOLD}${specFiles.length}${RESET} specs in ${DIM}${resolvedDir}${RESET}`);
        console.log(`${DIM}[${mode}]${RESET}\n`);
        if (!parallel) {
          specFiles.forEach((f, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${f}`));
          console.log('');
        }
        if (parallel && sequentialFirst > 0) {
          console.log(`Sequential-first: ${Math.min(sequentialFirst, specFiles.length)} spec(s) run before parallel phase\n`);
        }
      }

      const specFilePaths = specFiles.map(f => path.join(resolvedDir, f));

      const wallClockStart = Date.now();
      const results = await runSpecBatch(specFilePaths, specFiles, options, concurrency, runId);
      const wallClockDuration = (Date.now() - wallClockStart) / 1000;

      printBatchSummary(results, wallClockDuration, parallel ?? false, quiet ?? false);

      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Spec directory not found: ${resolvedDir}`);
      }
      throw err;
    }
  }

  // Auto-detect: if prompt looks like a path to an existing .md file, treat as --spec
  const effectiveOptions = { ...options };
  if (!effectiveOptions.specPath && !effectiveOptions.specDir && effectiveOptions.prompt.endsWith('.md')) {
    const candidatePath = path.resolve(effectiveOptions.cwd || '.', effectiveOptions.prompt);
    try {
      await fs.access(candidatePath);
      effectiveOptions.specPath = effectiveOptions.prompt;
      effectiveOptions.prompt = 'implement this specification';
      if (!quiet) {
        console.log(`${DIM}[forge]${RESET} Detected spec file: ${DIM}${effectiveOptions.specPath}${RESET}\n`);
      }
    } catch {
      // Not a file — treat as regular prompt
    }
  }

  // Single spec or no spec - run directly
  await runSingleSpec({ ...effectiveOptions, _runId: runId });
}
