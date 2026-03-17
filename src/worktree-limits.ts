// ── Worktree Limits & Disk Quota Enforcement ─────────────────
//
// Configurable limits on worktree count and total disk usage.
// When limits are exceeded, new worktree creation is blocked
// with a clear message suggesting `forge worktree prune`.

import { execAsync, cleanupWorktree } from './utils.js';
import { getDb, listWorktrees, updateWorktreeStatus } from './db.js';
import type { WorktreeRow } from './db.js';
import { getConfig } from './config.js';

// ── Types ────────────────────────────────────────────────────

export interface WorktreeLimitCheck {
  /** Whether limits are within bounds (creation may proceed). */
  ok: boolean;
  /** If not ok, the user-facing error message. */
  error?: string;
  /** Current active (non-cleaned) worktree count. */
  activeCount: number;
  /** Configured max worktrees. */
  maxWorktrees: number;
  /** Current total disk usage in MB (best-effort, -1 if unavailable). */
  diskUsageMb: number;
  /** Configured max disk usage in MB. */
  maxDiskMb: number;
}

// ── Disk Usage Calculation ───────────────────────────────────

/**
 * Calculate the total disk usage of all worktrees that still have directories on disk.
 * Uses `du -sk` (kilobytes) for portability across macOS and Linux.
 *
 * Best-effort: if `du` fails for a directory, it is skipped with a warning.
 * Returns -1 if no directories could be measured at all.
 */
export async function calculateWorktreeDiskUsage(worktrees: WorktreeRow[]): Promise<number> {
  const nonCleaned = worktrees.filter(w => w.status !== 'cleaned');
  if (nonCleaned.length === 0) return 0;

  let totalKb = 0;
  let measured = 0;

  for (const wt of nonCleaned) {
    try {
      const { stdout } = await execAsync(`du -sk "${wt.worktree_path}"`, {
        timeout: 10000, // 10s per directory -- generous for large repos
      });
      const kb = parseInt(stdout.split(/\s+/)[0], 10);
      if (!isNaN(kb)) {
        totalKb += kb;
        measured++;
      }
    } catch {
      // Best-effort -- directory may not exist, du may fail on network mounts, etc.
      // Skip silently; the warning is surfaced when limit checks fail.
    }
  }

  if (measured === 0 && nonCleaned.length > 0) {
    return -1; // Could not measure any directories
  }

  return Math.ceil(totalKb / 1024); // Convert KB to MB
}

/**
 * Count active worktrees (all statuses except 'cleaned').
 */
export function countActiveWorktrees(worktrees: WorktreeRow[]): number {
  return worktrees.filter(w => w.status !== 'cleaned').length;
}

// ── Limit Checking ───────────────────────────────────────────

/**
 * Check worktree count and disk usage limits.
 * Returns a result indicating whether creation may proceed.
 *
 * Disk usage check is best-effort: if `du` fails entirely, the disk check
 * is skipped (logs a warning) and only the count limit is enforced.
 */
export async function checkWorktreeLimits(repoDir: string): Promise<WorktreeLimitCheck> {
  const config = getConfig(repoDir);
  const maxWorktrees = config.maxWorktrees;
  const maxDiskMb = config.maxWorktreeDiskMb;

  const db = getDb(repoDir);
  if (!db) {
    // No DB -- can't check limits, allow creation
    return { ok: true, activeCount: 0, maxWorktrees, diskUsageMb: -1, maxDiskMb };
  }

  const allWorktrees = listWorktrees(db);
  const activeCount = countActiveWorktrees(allWorktrees);

  // ── Count limit check ──────────────────────────────────
  if (activeCount >= maxWorktrees) {
    const activeList = allWorktrees
      .filter(w => w.status !== 'cleaned')
      .slice(0, 10)
      .map(w => `  ${w.id.substring(0, 8)}  ${w.status.padEnd(12)}  ${w.spec_path}`)
      .join('\n');

    const error = [
      `Worktree limit reached: ${activeCount}/${maxWorktrees} active worktrees.`,
      '',
      activeList,
      activeCount > 10 ? `  ... and ${activeCount - 10} more` : '',
      '',
      'To free up worktrees, run:  forge worktree prune',
      'To override this limit:     use --force flag',
      `To change the limit:        set maxWorktrees in .forge/config.json (currently ${maxWorktrees})`,
    ].filter(Boolean).join('\n');

    return { ok: false, error, activeCount, maxWorktrees, diskUsageMb: -1, maxDiskMb };
  }

  // ── Disk usage limit check ─────────────────────────────
  const diskUsageMb = await calculateWorktreeDiskUsage(allWorktrees);

  if (diskUsageMb === -1) {
    // Could not measure disk usage -- skip check, log warning
    console.warn('[forge] Could not calculate worktree disk usage -- skipping disk limit check');
    return { ok: true, activeCount, maxWorktrees, diskUsageMb: -1, maxDiskMb };
  }

  if (diskUsageMb >= maxDiskMb) {
    const error = [
      `Worktree disk limit reached: ${diskUsageMb}MB / ${maxDiskMb}MB used.`,
      '',
      'To free up disk space, run:  forge worktree prune',
      'To override this limit:      use --force flag',
      `To change the limit:         set maxWorktreeDiskMb in .forge/config.json (currently ${maxDiskMb})`,
    ].join('\n');

    return { ok: false, error, activeCount, maxWorktrees, diskUsageMb, maxDiskMb };
  }

  return { ok: true, activeCount, maxWorktrees, diskUsageMb, maxDiskMb };
}

// ── Auto-Prune ─────────────────────────────────────────────

/** Auto-prune threshold: prune when disk usage exceeds this fraction of the limit. */
const AUTO_PRUNE_THRESHOLD = 0.8;

export interface AutoPruneResult {
  /** Whether auto-prune was attempted. */
  attempted: boolean;
  /** Worktrees that were successfully pruned. */
  pruned: WorktreeRow[];
  /** Disk usage in MB after pruning (-1 if unmeasurable). */
  diskAfterMb: number;
  /** Whether disk usage is still above the threshold after pruning. */
  stillAboveThreshold: boolean;
}

/**
 * Auto-prune merged worktrees when disk usage exceeds 80% of maxWorktreeDiskMb.
 *
 * Only prunes worktrees with status 'merged' (safe to remove -- work has been
 * consolidated). Removes oldest-first (by updated_at ASC).
 *
 * If pruning all merged worktrees is insufficient to get below 80%, logs a
 * warning but does not touch complete/ready worktrees (those may have unmerged work).
 *
 * @param repoDir - The repository working directory
 * @param quiet - Suppress console output (default: false)
 * @returns AutoPruneResult with details of what was pruned
 */
export async function autoPruneMergedWorktrees(
  repoDir: string,
  quiet = false,
): Promise<AutoPruneResult> {
  const noOp: AutoPruneResult = { attempted: false, pruned: [], diskAfterMb: -1, stillAboveThreshold: false };

  const config = getConfig(repoDir);
  const maxDiskMb = config.maxWorktreeDiskMb;
  const threshold = maxDiskMb * AUTO_PRUNE_THRESHOLD;

  const db = getDb(repoDir);
  if (!db) return noOp;

  const allWorktrees = listWorktrees(db);
  const diskUsageMb = await calculateWorktreeDiskUsage(allWorktrees);

  // Can't measure or below threshold -- nothing to do
  if (diskUsageMb === -1 || diskUsageMb < threshold) {
    return { ...noOp, diskAfterMb: diskUsageMb };
  }

  // Find merged worktrees, oldest first (updated_at ASC)
  const merged = allWorktrees
    .filter(w => w.status === 'merged')
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));

  if (merged.length === 0) {
    // Above threshold but nothing safe to prune
    if (!quiet) {
      console.warn(
        `[forge] Disk usage ${diskUsageMb}MB exceeds 80% of ${maxDiskMb}MB limit, ` +
        `but no merged worktrees available to auto-prune`,
      );
    }
    return { attempted: true, pruned: [], diskAfterMb: diskUsageMb, stillAboveThreshold: true };
  }

  if (!quiet) {
    console.log(`[forge] Disk usage ${diskUsageMb}MB exceeds 80% of ${maxDiskMb}MB -- auto-pruning merged worktrees`);
  }

  const pruned: WorktreeRow[] = [];

  for (const wt of merged) {
    // Re-check disk usage after each prune to stop early
    const currentWorktrees = listWorktrees(db);
    const currentDisk = await calculateWorktreeDiskUsage(currentWorktrees);
    if (currentDisk !== -1 && currentDisk < threshold) {
      break; // Below threshold -- stop pruning
    }

    try {
      // Remove the worktree directory (runs teardown hooks)
      await cleanupWorktree(wt.worktree_path, repoDir, { runTeardown: true, quiet: true });

      // Safe-delete the branch (-d, not -D)
      try {
        await execAsync(`git branch -d "${wt.branch}"`, { cwd: repoDir });
      } catch {
        // Branch may not exist or may not be fully merged -- best effort
      }

      // Update registry status to cleaned
      updateWorktreeStatus(db, wt.id, 'cleaned');
      pruned.push(wt);

      if (!quiet) {
        console.log(`  + ${wt.id.substring(0, 8)}  ${wt.spec_path}  (merged -> cleaned)`);
      }
    } catch (err) {
      // Best-effort -- log and continue to next worktree
      if (!quiet) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  x ${wt.id.substring(0, 8)}  ${wt.spec_path}  ${msg}`);
      }
    }
  }

  // Final disk measurement
  const finalWorktrees = listWorktrees(db);
  const diskAfterMb = await calculateWorktreeDiskUsage(finalWorktrees);
  const stillAboveThreshold = diskAfterMb !== -1 && diskAfterMb >= threshold;

  if (stillAboveThreshold && !quiet) {
    console.warn(
      `[forge] Disk usage still at ${diskAfterMb}MB after auto-pruning ${pruned.length} merged worktrees. ` +
      `Run 'forge worktree prune --force' to prune non-merged worktrees.`,
    );
  } else if (pruned.length > 0 && !quiet) {
    console.log(`[forge] Auto-pruned ${pruned.length} merged worktrees, disk now ${diskAfterMb}MB/${maxDiskMb}MB`);
  }

  return { attempted: true, pruned, diskAfterMb, stillAboveThreshold };
}
