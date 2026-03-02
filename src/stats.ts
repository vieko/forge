import type { ForgeResult, SpecManifest } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { DIM, RESET, BOLD } from './display.js';
import { loadManifest } from './specs.js';

// ── Options ──────────────────────────────────────────────────

export interface StatsOptions {
  /** Working directory (target repo) */
  cwd?: string;
  /** Only include runs after this ISO date */
  since?: string;
  /** Show per-spec breakdown */
  bySpec?: boolean;
  /** Show per-model breakdown */
  byModel?: boolean;
}

// ── Duration formatting ──────────────────────────────────────

/** Format seconds into a human-readable duration (e.g. "2m10s", "1.5h"). */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  const h = seconds / 3600;
  return `${h.toFixed(1)}h`;
}

// ── Load summaries ───────────────────────────────────────────

/** Load all summary.json files from .forge/results/. */
export async function loadSummaries(workingDir: string): Promise<ForgeResult[]> {
  const resultsBase = path.join(workingDir, '.forge', 'results');

  let dirs: string[];
  try {
    dirs = await fs.readdir(resultsBase);
  } catch {
    return [];
  }

  const summaries: ForgeResult[] = [];
  for (const dir of dirs) {
    try {
      const content = await fs.readFile(
        path.join(resultsBase, dir, 'summary.json'),
        'utf-8',
      );
      summaries.push(JSON.parse(content) as ForgeResult);
    } catch {
      continue;
    }
  }

  return summaries;
}

// ── Aggregation helpers ──────────────────────────────────────

export interface AggregatedStats {
  total: number;
  passed: number;
  failed: number;
  totalCost: number;
  totalDuration: number;
  totalTurns: number;
  runsWithTurns: number;
}

export function aggregateRuns(summaries: ForgeResult[]): AggregatedStats {
  let passed = 0;
  let failed = 0;
  let totalCost = 0;
  let totalDuration = 0;
  let totalTurns = 0;
  let runsWithTurns = 0;

  for (const s of summaries) {
    if (s.status === 'success') {
      passed++;
    } else {
      failed++;
    }
    totalCost += s.costUsd ?? 0;
    totalDuration += s.durationSeconds;
    if (s.numTurns !== undefined) {
      totalTurns += s.numTurns;
      runsWithTurns++;
    }
  }

  return {
    total: summaries.length,
    passed,
    failed,
    totalCost,
    totalDuration,
    totalTurns,
    runsWithTurns,
  };
}

// ── Per-spec stats ───────────────────────────────────────────

export interface SpecStats {
  spec: string;
  runs: number;
  passed: number;
  avgCost: number;
  avgDuration: number;
}

export function computeSpecStats(manifest: SpecManifest): SpecStats[] {
  const results: SpecStats[] = [];

  for (const entry of manifest.specs) {
    if (entry.runs.length === 0) continue;

    const passed = entry.runs.filter(r => r.status === 'passed').length;
    const totalCost = entry.runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const totalDuration = entry.runs.reduce((sum, r) => sum + r.durationSeconds, 0);

    results.push({
      spec: entry.spec,
      runs: entry.runs.length,
      passed,
      avgCost: totalCost / entry.runs.length,
      avgDuration: totalDuration / entry.runs.length,
    });
  }

  // Sort by number of runs descending
  results.sort((a, b) => b.runs - a.runs);
  return results;
}

// ── Per-model stats ──────────────────────────────────────────

export interface ModelStats {
  model: string;
  runs: number;
  passed: number;
  avgCost: number;
  avgDuration: number;
}

export function computeModelStats(summaries: ForgeResult[]): ModelStats[] {
  const groups = new Map<string, ForgeResult[]>();

  for (const s of summaries) {
    const model = s.model || 'unknown';
    const arr = groups.get(model) || [];
    arr.push(s);
    groups.set(model, arr);
  }

  const results: ModelStats[] = [];
  for (const [model, runs] of groups) {
    const passed = runs.filter(r => r.status === 'success').length;
    const totalCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const totalDuration = runs.reduce((sum, r) => sum + r.durationSeconds, 0);

    results.push({
      model,
      runs: runs.length,
      passed,
      avgCost: totalCost / runs.length,
      avgDuration: totalDuration / runs.length,
    });
  }

  // Sort by number of runs descending
  results.sort((a, b) => b.runs - a.runs);
  return results;
}

// ── Date filter ──────────────────────────────────────────────

/** Validate an ISO date string. Returns true if parseable. */
export function isValidDate(dateStr: string): boolean {
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

/** Filter summaries to those started at or after the given ISO date. */
export function filterSince(summaries: ForgeResult[], since: string): ForgeResult[] {
  return summaries.filter(s => s.startedAt >= since);
}

// ── Main command ─────────────────────────────────────────────

export async function showStats(options: StatsOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();

  // Validate --since
  if (options.since && !isValidDate(options.since)) {
    console.error(`Error: Invalid date for --since: "${options.since}". Use ISO 8601 format (e.g. 2026-01-15).`);
    process.exit(1);
  }

  // Load summaries
  let summaries = await loadSummaries(workingDir);

  if (summaries.length === 0) {
    console.log('No runs found.');
    return;
  }

  // Apply date filter
  if (options.since) {
    summaries = filterSince(summaries, options.since);
    if (summaries.length === 0) {
      console.log(`No runs found since ${options.since}.`);
      return;
    }
  }

  // Per-spec breakdown
  if (options.bySpec) {
    const manifest = await loadManifest(workingDir);
    const specStats = computeSpecStats(manifest);

    if (specStats.length === 0) {
      console.log('No spec run data in manifest.');
      return;
    }

    // Dynamic column width
    const nameWidth = Math.max(20, ...specStats.map(s => s.spec.length));

    console.log(`\n${BOLD}Per-Spec Breakdown${RESET}`);
    if (options.since) console.log(`${DIM}(since ${options.since})${RESET}`);
    console.log();

    // Header
    console.log(
      `  ${'Spec'.padEnd(nameWidth)}  ${'Runs'.padStart(5)}  ${'Pass'.padStart(5)}  ${'Avg Cost'.padStart(9)}  ${'Avg Time'.padStart(9)}`,
    );
    console.log(`  ${DIM}${'─'.repeat(nameWidth + 36)}${RESET}`);

    for (const s of specStats) {
      const passRate = s.runs > 0 ? `${Math.round((s.passed / s.runs) * 100)}%` : '-';
      const avgCost = s.avgCost > 0 ? `$${s.avgCost.toFixed(2)}` : '-';
      const avgTime = formatDuration(s.avgDuration);

      console.log(
        `  ${s.spec.padEnd(nameWidth)}  ${String(s.runs).padStart(5)}  ${passRate.padStart(5)}  ${avgCost.padStart(9)}  ${avgTime.padStart(9)}`,
      );
    }

    console.log('');
    return;
  }

  // Per-model breakdown
  if (options.byModel) {
    const modelStats = computeModelStats(summaries);

    if (modelStats.length === 0) {
      console.log('No run data found.');
      return;
    }

    // Dynamic column width
    const nameWidth = Math.max(10, ...modelStats.map(s => s.model.length));

    console.log(`\n${BOLD}Per-Model Breakdown${RESET}`);
    if (options.since) console.log(`${DIM}(since ${options.since})${RESET}`);
    console.log();

    // Header
    console.log(
      `  ${'Model'.padEnd(nameWidth)}  ${'Runs'.padStart(5)}  ${'Pass'.padStart(5)}  ${'Avg Cost'.padStart(9)}  ${'Avg Time'.padStart(9)}`,
    );
    console.log(`  ${DIM}${'─'.repeat(nameWidth + 36)}${RESET}`);

    for (const s of modelStats) {
      const passRate = s.runs > 0 ? `${Math.round((s.passed / s.runs) * 100)}%` : '-';
      const avgCost = s.avgCost > 0 ? `$${s.avgCost.toFixed(2)}` : '-';
      const avgTime = formatDuration(s.avgDuration);

      console.log(
        `  ${s.model.padEnd(nameWidth)}  ${String(s.runs).padStart(5)}  ${passRate.padStart(5)}  ${avgCost.padStart(9)}  ${avgTime.padStart(9)}`,
      );
    }

    console.log('');
    return;
  }

  // Default dashboard
  const stats = aggregateRuns(summaries);

  console.log(`\n${BOLD}Forge Stats${RESET}`);
  if (options.since) console.log(`${DIM}(since ${options.since})${RESET}`);
  console.log();

  // Runs
  const passLabel = stats.passed > 0 ? `\x1b[32m${stats.passed} passed\x1b[0m` : '';
  const failLabel = stats.failed > 0 ? `\x1b[31m${stats.failed} failed\x1b[0m` : '';
  const breakdown = [passLabel, failLabel].filter(Boolean).join(', ');
  console.log(`  Runs:      ${BOLD}${stats.total}${RESET} total${breakdown ? ` (${breakdown})` : ''}`);

  // Success rate
  const successRate = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(1) : '0.0';
  console.log(`  Success:   ${BOLD}${successRate}%${RESET}`);

  // Cost
  const avgCost = stats.total > 0 ? stats.totalCost / stats.total : 0;
  console.log(`  Cost:      ${BOLD}$${stats.totalCost.toFixed(2)}${RESET} total${stats.total > 0 ? ` ($${avgCost.toFixed(2)} avg/run)` : ''}`);

  // Duration
  const avgDuration = stats.total > 0 ? stats.totalDuration / stats.total : 0;
  console.log(`  Duration:  ${BOLD}${formatDuration(stats.totalDuration)}${RESET} total${stats.total > 0 ? ` (${formatDuration(avgDuration)} avg/run)` : ''}`);

  // Turns
  if (stats.runsWithTurns > 0) {
    const avgTurns = stats.totalTurns / stats.runsWithTurns;
    console.log(`  Turns:     ${BOLD}${avgTurns.toFixed(1)}${RESET} avg/run`);
  }

  console.log('');
}
