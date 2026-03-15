import path from 'path';
import { DIM, RESET, BOLD } from './display.js';
import {
  getDb,
  queryAggregateStats,
  querySpecStats,
  queryModelStats as queryModelStatsDb,
  querySourceStats,
} from './db.js';
import type { AggregateRow, SourceStatsRow } from './db.js';

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
  /** Show per-source breakdown (CLI vs MCP) */
  bySource?: boolean;
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

// ── Date validation ─────────────────────────────────────────

/** Validate an ISO date string. Returns true if parseable. */
export function isValidDate(dateStr: string): boolean {
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

// ── Display helpers ─────────────────────────────────────────

function printSpecBreakdown(specStats: { spec: string; runs: number; passed: number; avgCost: number; avgDuration: number }[], since?: string): void {
  if (specStats.length === 0) {
    console.log('No spec run data found.');
    return;
  }

  const nameWidth = Math.max(20, ...specStats.map(s => s.spec.length));

  console.log(`\n${BOLD}Per-Spec Breakdown${RESET}`);
  if (since) console.log(`${DIM}(since ${since})${RESET}`);
  console.log();

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
}

function printModelBreakdown(modelStats: { model: string; runs: number; passed: number; avgCost: number; avgDuration: number }[], since?: string): void {
  if (modelStats.length === 0) {
    console.log('No run data found.');
    return;
  }

  const nameWidth = Math.max(10, ...modelStats.map(s => s.model.length));

  console.log(`\n${BOLD}Per-Model Breakdown${RESET}`);
  if (since) console.log(`${DIM}(since ${since})${RESET}`);
  console.log();

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
}

function printSourceBreakdown(sourceStats: SourceStatsRow[], since?: string): void {
  if (sourceStats.length === 0) {
    console.log('No task data found.');
    return;
  }

  const nameWidth = Math.max(10, ...sourceStats.map(s => s.source.length));

  console.log(`\n${BOLD}Per-Source Breakdown${RESET} ${DIM}(tasks)${RESET}`);
  if (since) console.log(`${DIM}(since ${since})${RESET}`);
  console.log();

  console.log(
    `  ${'Source'.padEnd(nameWidth)}  ${'Total'.padStart(6)}  ${'Done'.padStart(6)}  ${'Failed'.padStart(6)}  ${'Cancel'.padStart(6)}`,
  );
  console.log(`  ${DIM}${'─'.repeat(nameWidth + 30)}${RESET}`);

  for (const s of sourceStats) {
    console.log(
      `  ${s.source.padEnd(nameWidth)}  ${String(s.total).padStart(6)}  ${String(s.completed).padStart(6)}  ${String(s.failed).padStart(6)}  ${String(s.cancelled).padStart(6)}`,
    );
  }

  console.log('');
}

function printDashboard(stats: AggregateRow, since?: string): void {
  console.log(`\n${BOLD}Forge Stats${RESET}`);
  if (since) console.log(`${DIM}(since ${since})${RESET}`);
  console.log();

  const passLabel = stats.passed > 0 ? `\x1b[32m${stats.passed} passed\x1b[0m` : '';
  const failLabel = stats.failed > 0 ? `\x1b[31m${stats.failed} failed\x1b[0m` : '';
  const breakdown = [passLabel, failLabel].filter(Boolean).join(', ');
  console.log(`  Runs:      ${BOLD}${stats.total}${RESET} total${breakdown ? ` (${breakdown})` : ''}`);

  const successRate = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(1) : '0.0';
  console.log(`  Success:   ${BOLD}${successRate}%${RESET}`);

  const avgCost = stats.total > 0 ? stats.totalCost / stats.total : 0;
  console.log(`  Cost:      ${BOLD}$${stats.totalCost.toFixed(2)}${RESET} total${stats.total > 0 ? ` ($${avgCost.toFixed(2)} avg/run)` : ''}`);

  const avgDuration = stats.total > 0 ? stats.totalDuration / stats.total : 0;
  console.log(`  Duration:  ${BOLD}${formatDuration(stats.totalDuration)}${RESET} total${stats.total > 0 ? ` (${formatDuration(avgDuration)} avg/run)` : ''}`);

  if (stats.runsWithTurns > 0) {
    const avgTurns = stats.totalTurns / stats.runsWithTurns;
    console.log(`  Turns:     ${BOLD}${avgTurns.toFixed(1)}${RESET} avg/run`);
  }

  console.log('');
}

// ── DB-backed stats queries ─────────────────────────────────

/**
 * Try to serve stats from the DB. Returns true if successful,
 * false if DB is unavailable.
 */
function showStatsFromDb(workingDir: string, options: StatsOptions): boolean {
  const db = getDb(workingDir);
  if (!db) return false;

  try {
    if (options.bySource) {
      const rows = querySourceStats(db, options.since);
      printSourceBreakdown(rows, options.since);
      return true;
    }

    if (options.bySpec) {
      const rows = querySpecStats(db, options.since);
      const specStats = rows.map(r => ({
        spec: r.specPath,
        runs: r.runs,
        passed: r.passed,
        avgCost: r.avgCost,
        avgDuration: r.avgDuration,
      }));
      printSpecBreakdown(specStats, options.since);
      return true;
    }

    if (options.byModel) {
      const rows = queryModelStatsDb(db, options.since);
      const modelStats = rows.map(r => ({
        model: r.model,
        runs: r.runs,
        passed: r.passed,
        avgCost: r.avgCost,
        avgDuration: r.avgDuration,
      }));
      printModelBreakdown(modelStats, options.since);
      return true;
    }

    // Default dashboard
    const row = queryAggregateStats(db, options.since);
    if (row.total === 0) {
      if (options.since) {
        console.log(`No runs found since ${options.since}.`);
      } else {
        console.log('No runs found.');
      }
      return true;
    }

    printDashboard(row, options.since);
    return true;
  } catch {
    return false;
  }
}

// ── Main command ─────────────────────────────────────────────

export async function showStats(options: StatsOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();

  // Validate --since
  if (options.since && !isValidDate(options.since)) {
    console.error(`Error: Invalid date for --since: "${options.since}". Use ISO 8601 format (e.g. 2026-01-15).`);
    process.exit(1);
  }

  // Read exclusively from DB
  const served = showStatsFromDb(workingDir, options);
  if (served) return;

  // DB unavailable
  console.log('No runs found. (Database unavailable)');
}
