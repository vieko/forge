import type { ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { DIM, RESET, BOLD, showBanner } from './display.js';

// Display status of recent runs
export async function showStatus(options: { cwd?: string; all?: boolean; last?: number }): Promise<void> {
  showBanner();
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const resultsBase = path.join(workingDir, '.forge', 'results');

  let dirs: string[];
  try {
    dirs = (await fs.readdir(resultsBase)).sort().reverse(); // newest first
  } catch {
    console.log('No results found.');
    return;
  }

  // Load all summaries
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

  // Group by runId (ungrouped specs get their own entry)
  const groups = new Map<string, ForgeResult[]>();
  for (const s of summaries) {
    const key = s.runId || s.startedAt; // Use startedAt as unique key for non-batch runs
    const arr = groups.get(key) || [];
    arr.push(s);
    groups.set(key, arr);
  }

  // Convert to array sorted by newest first
  const groupEntries = Array.from(groups.entries()).sort((a, b) => {
    const aTime = a[1][0].startedAt;
    const bTime = b[1][0].startedAt;
    return bTime.localeCompare(aTime);
  });

  // Limit display
  const limit = options.all ? groupEntries.length : (options.last || 1);
  const displayed = groupEntries.slice(0, limit);

  for (const [key, specs] of displayed) {
    const isBatch = specs.length > 1 || specs[0].runId;
    const successCount = specs.filter(s => s.status === 'success').length;
    const totalCost = specs.reduce((sum, s) => sum + (s.costUsd || 0), 0);
    const totalDuration = specs.reduce((sum, s) => sum + s.durationSeconds, 0);

    // Dynamic name width based on spec names in this group
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
      const statusIcon = s.status === 'success' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const cost = s.costUsd !== undefined ? `$${s.costUsd.toFixed(2)}` : '   -';
      console.log(`  ${statusIcon} ${name.padEnd(nameWidth)} ${s.durationSeconds.toFixed(1).padStart(6)}s  ${cost}`);
    }

    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`  Duration: ${BOLD}${totalDuration.toFixed(1)}s${RESET}`);
    console.log(`  Cost:     ${BOLD}$${totalCost.toFixed(2)}${RESET}`);
    console.log(`  Result:   ${successCount === specs.length ? '\x1b[32m' : '\x1b[33m'}${successCount}/${specs.length} successful\x1b[0m`);
  }

  console.log('');
}
