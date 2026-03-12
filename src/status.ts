import type { ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { DIM, RESET, BOLD, showBanner } from './display.js';
import { getDbWithBackfill, queryStatusRuns } from './db.js';
import type { StatusRunRow } from './db.js';

// ── Shared display logic ────────────────────────────────────

interface StatusSpec {
  specPath: string | null;
  status: string;
  costUsd: number | null;
  durationSeconds: number;
  startedAt: string;
  batchId: string | null;
}

function printGroups(
  groupEntries: [string, StatusSpec[]][],
  options: { all?: boolean; last?: number },
): void {
  const limit = options.all ? groupEntries.length : (options.last || 1);
  const displayed = groupEntries.slice(0, limit);

  for (const [key, specs] of displayed) {
    const isBatch = specs.length > 1 || specs[0].batchId;
    const successCount = specs.filter(s => s.status === 'success').length;
    const totalCost = specs.reduce((sum, s) => sum + (s.costUsd || 0), 0);
    const totalDuration = specs.reduce((sum, s) => sum + s.durationSeconds, 0);

    const names = specs.map(s => s.specPath ? path.basename(s.specPath) : '(no spec)');
    const nameWidth = Math.max(20, ...names.map(n => n.length));

    console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
    if (isBatch) {
      console.log(`${BOLD}Batch${RESET} ${DIM}${key.substring(0, 8)}${RESET}  ${specs[0].startedAt}`);
    } else {
      console.log(`${BOLD}Run${RESET}  ${specs[0].startedAt}`);
    }
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);

    for (const s of specs) {
      const name = s.specPath ? path.basename(s.specPath) : '(no spec)';
      const statusIcon = s.status === 'success' ? '\x1b[32m+\x1b[0m' : '\x1b[31mx\x1b[0m';
      const cost = s.costUsd != null ? `$${s.costUsd.toFixed(2)}` : '   -';
      console.log(`  ${statusIcon} ${name.padEnd(nameWidth)} ${s.durationSeconds.toFixed(1).padStart(6)}s  ${cost}`);
    }

    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`  Duration: ${BOLD}${totalDuration.toFixed(1)}s${RESET}`);
    console.log(`  Cost:     ${BOLD}$${totalCost.toFixed(2)}${RESET}`);
    console.log(`  Result:   ${successCount === specs.length ? '\x1b[32m' : '\x1b[33m'}${successCount}/${specs.length} successful\x1b[0m`);

    // Next-step hint (only for the most recent group)
    if (key === displayed[0][0]) {
      const specDir = specs[0].specPath ? path.dirname(specs[0].specPath) : null;
      if (successCount < specs.length) {
        console.log(`\n  ${DIM}Next step:${RESET}`);
        console.log(`    forge run --rerun-failed "fix failures"`);
      } else if (specDir && isBatch) {
        console.log(`\n  ${DIM}Next step:${RESET}`);
        console.log(`    forge audit ${specDir} --fix "verify and fix"`);
      }
    }
  }

  console.log('');
}

// ── DB-backed status ────────────────────────────────────────

function showStatusFromDb(rows: StatusRunRow[], options: { all?: boolean; last?: number }): void {
  if (rows.length === 0) {
    console.log('No results found.');
    return;
  }

  // Group by batchId (ungrouped runs get their own entry via startedAt)
  const groups = new Map<string, StatusSpec[]>();
  for (const r of rows) {
    const key = r.batchId || r.startedAt;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({
      specPath: r.specPath,
      status: r.status,
      costUsd: r.costUsd,
      durationSeconds: r.durationSeconds,
      startedAt: r.startedAt,
      batchId: r.batchId,
    });
  }

  // Sort newest first
  const groupEntries = Array.from(groups.entries()).sort((a, b) => {
    return b[1][0].startedAt.localeCompare(a[1][0].startedAt);
  });

  printGroups(groupEntries, options);
}

// ── Filesystem fallback ─────────────────────────────────────

async function showStatusFromFilesystem(
  workingDir: string,
  options: { all?: boolean; last?: number },
): Promise<void> {
  const resultsBase = path.join(workingDir, '.forge', 'results');

  let dirs: string[];
  try {
    dirs = (await fs.readdir(resultsBase)).sort().reverse();
  } catch {
    console.log('No results found.');
    return;
  }

  const summaries: ForgeResult[] = [];
  for (const dir of dirs) {
    try {
      const summary: ForgeResult = JSON.parse(
        await fs.readFile(path.join(resultsBase, dir, 'summary.json'), 'utf-8')
      );
      summaries.push(summary);
    } catch { continue; }
  }

  if (summaries.length === 0) {
    console.log('No results found.');
    return;
  }

  // Group by runId
  const groups = new Map<string, StatusSpec[]>();
  for (const s of summaries) {
    const key = s.runId || s.startedAt;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({
      specPath: s.specPath || null,
      status: s.status,
      costUsd: s.costUsd ?? null,
      durationSeconds: s.durationSeconds,
      startedAt: s.startedAt,
      batchId: s.runId || null,
    });
  }

  const groupEntries = Array.from(groups.entries()).sort((a, b) => {
    return b[1][0].startedAt.localeCompare(a[1][0].startedAt);
  });

  printGroups(groupEntries, options);
}

// ── Main command ─────────────────────────────────────────────

export async function showStatus(options: { cwd?: string; all?: boolean; last?: number }): Promise<void> {
  showBanner();
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();

  // Try DB-backed status first
  try {
    const db = await getDbWithBackfill(workingDir);
    if (db) {
      const rows = queryStatusRuns(db);
      showStatusFromDb(rows, options);
      return;
    }
  } catch {
    // Fall through to filesystem
  }

  // Fallback: filesystem scanning
  await showStatusFromFilesystem(workingDir, options);
}
