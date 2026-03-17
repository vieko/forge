// ── Worktree CLI Commands ─────────────────────────────────────
//
// CLI subcommands for worktree management: list, status, mark-ready, prune, repair.
// Reads from the SQLite worktrees table (DB-primary).

import fs from 'fs/promises';
import path from 'path';
import { DIM, RESET, BOLD } from './display.js';
import { formatDuration } from './stats.js';
import {
  getDb,
  listWorktrees,
  getWorktreesByWorkGroup,
  getWorktree,
  getSpecRunsByEntry,
  getSpecEntryByPath,
  transitionWorktreeStatus,
  updateWorktreeStatus,
} from './db.js';
import type { WorktreeRow, WorktreeStatus } from './db.js';
import { countActiveWorktrees, calculateWorktreeDiskUsage, autoPruneMergedWorktrees } from './worktree-limits.js';
import { getConfig } from './config.js';
import { cleanupWorktree } from './utils.js';
import { execAsync } from './utils.js';

// ── Status icons ─────────────────────────────────────────────

/** ASCII status icon consistent with forge specs/status output. */
function worktreeStatusIcon(status: WorktreeStatus): string {
  switch (status) {
    case 'merged':
    case 'cleaned':
    case 'complete':
    case 'audited':
    case 'proofed':
    case 'ready':
      return '\x1b[32m+\x1b[0m';
    case 'running':
    case 'auditing':
    case 'proofing':
    case 'merging':
      return '\x1b[36m>\x1b[0m';
    case 'failed':
    case 'merge_failed':
      return '\x1b[31mx\x1b[0m';
    case 'paused':
      return '\x1b[33m~\x1b[0m';
    case 'created':
    default:
      return `${DIM}-${RESET}`;
  }
}

/** Format age from a timestamp to now as human-readable. */
function formatAge(isoTimestamp: string): string {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── List command ─────────────────────────────────────────────

export interface WorktreeListOptions {
  cwd?: string;
  status?: string;
  workGroup?: string;
  quiet?: boolean;
}

export async function showWorktreeList(options: WorktreeListOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const db = getDb(workingDir);

  if (!db) {
    console.log('No worktrees found. (Database unavailable)');
    return;
  }

  let worktrees: WorktreeRow[];
  if (options.workGroup) {
    worktrees = getWorktreesByWorkGroup(db, options.workGroup);
    if (options.status) {
      worktrees = worktrees.filter(w => w.status === options.status);
    }
  } else if (options.status) {
    worktrees = listWorktrees(db, options.status as WorktreeStatus);
  } else {
    worktrees = listWorktrees(db);
  }

  if (worktrees.length === 0) {
    const filterMsg = options.status
      ? ` with status '${options.status}'`
      : options.workGroup
        ? ` in work group '${options.workGroup}'`
        : '';
    console.log(`No worktrees found${filterMsg}.`);
    return;
  }

  // Sort by updated_at DESC (most recently updated first)
  worktrees.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  // Compute column widths
  const idWidth = 8; // truncated ID
  const specNames = worktrees.map(w => path.basename(w.spec_path));
  const specWidth = Math.max(12, ...specNames.map(n => n.length));
  const statusWidth = Math.max(8, ...worktrees.map(w => w.status.length));
  const branchNames = worktrees.map(w => w.branch.length > 24 ? w.branch.substring(0, 21) + '...' : w.branch);
  const branchWidth = Math.max(8, ...branchNames.map(n => n.length));

  // Header
  console.log(`\n${BOLD}Worktrees${RESET} ${DIM}(${worktrees.length} total)${RESET}`);
  console.log(`${DIM}${'─'.repeat(60)}${RESET}`);

  console.log(
    `  ${'ID'.padEnd(idWidth)}  ${'Spec'.padEnd(specWidth)}  ${'Status'.padEnd(statusWidth)}  ${'Branch'.padEnd(branchWidth)}  ${'Age'.padStart(8)}`,
  );
  console.log(`  ${DIM}${'─'.repeat(idWidth + specWidth + statusWidth + branchWidth + 16)}${RESET}`);

  for (let i = 0; i < worktrees.length; i++) {
    const w = worktrees[i];
    const icon = worktreeStatusIcon(w.status);
    const id = w.id.substring(0, idWidth);
    const spec = specNames[i].padEnd(specWidth);
    const status = w.status.padEnd(statusWidth);
    const branch = branchNames[i].padEnd(branchWidth);
    const age = formatAge(w.updated_at).padStart(8);

    console.log(`  ${icon} ${id}  ${spec}  ${status}  ${branch}  ${age}`);
  }

  // Summary counts
  const allWorktrees = options.workGroup || options.status ? listWorktrees(db) : worktrees;
  const counts: Record<string, number> = {};
  for (const w of allWorktrees) {
    counts[w.status] = (counts[w.status] || 0) + 1;
  }

  const parts: string[] = [];
  if (counts['running']) parts.push(`${counts['running']} running`);
  if (counts['complete']) parts.push(`${counts['complete']} complete`);
  if (counts['failed']) parts.push(`${counts['failed']} failed`);
  if (counts['ready']) parts.push(`${counts['ready']} ready`);
  if (counts['merged']) parts.push(`${counts['merged']} merged`);

  if (parts.length > 0 && !options.status && !options.workGroup) {
    console.log(`\n  ${DIM}${parts.join(', ')}${RESET}`);
  }

  // ── Limits summary ───────────────────────────────────────
  const config = getConfig(workingDir);
  const activeCount = countActiveWorktrees(allWorktrees);
  const countPct = config.maxWorktrees > 0 ? Math.round((activeCount / config.maxWorktrees) * 100) : 0;
  const countColor = countPct >= 90 ? '\x1b[31m' : countPct >= 70 ? '\x1b[33m' : DIM;

  let limitsLine = `  ${countColor}Worktrees: ${activeCount}/${config.maxWorktrees}${RESET}`;

  // Disk usage is async and best-effort
  const diskUsageMb = await calculateWorktreeDiskUsage(allWorktrees);
  if (diskUsageMb >= 0) {
    const diskPct = config.maxWorktreeDiskMb > 0 ? Math.round((diskUsageMb / config.maxWorktreeDiskMb) * 100) : 0;
    const diskColor = diskPct >= 90 ? '\x1b[31m' : diskPct >= 70 ? '\x1b[33m' : DIM;
    limitsLine += `  ${diskColor}Disk: ${diskUsageMb}MB/${config.maxWorktreeDiskMb}MB${RESET}`;
  }

  console.log(limitsLine);
  console.log('');
}

// ── Status command ───────────────────────────────────────────

export interface WorktreeStatusOptions {
  cwd?: string;
  quiet?: boolean;
}

export async function showWorktreeStatus(id: string, options: WorktreeStatusOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const db = getDb(workingDir);

  if (!db) {
    console.error('Database unavailable.');
    process.exit(1);
  }

  const worktree = getWorktree(db, id);
  if (!worktree) {
    console.error(`Worktree not found: ${id}`);
    process.exit(1);
  }

  const icon = worktreeStatusIcon(worktree.status);
  const specPaths: string[] = JSON.parse(worktree.spec_paths);

  console.log(`\n${BOLD}Worktree${RESET} ${DIM}${worktree.id}${RESET}`);
  console.log(`${DIM}${'─'.repeat(60)}${RESET}`);

  console.log(`  Status:     ${icon} ${worktree.status}`);
  console.log(`  Branch:     ${BOLD}${worktree.branch}${RESET}`);
  console.log(`  Path:       ${worktree.worktree_path}`);
  console.log(`  Spec:       ${worktree.spec_path}`);

  if (specPaths.length > 1) {
    console.log(`  Specs:      ${specPaths.length} files`);
    for (const sp of specPaths) {
      console.log(`              ${DIM}${sp}${RESET}`);
    }
  }

  if (worktree.work_group_id) {
    console.log(`  Work group: ${DIM}${worktree.work_group_id}${RESET}`);
  }

  if (worktree.linear_issue_id) {
    console.log(`  Issue:      ${worktree.linear_issue_id}`);
  }

  if (worktree.task_id) {
    console.log(`  Task:       ${DIM}${worktree.task_id}${RESET}`);
  }

  if (worktree.session_id) {
    console.log(`  Session:    ${DIM}${worktree.session_id}${RESET}`);
  }

  if (worktree.error) {
    console.log(`  Error:      \x1b[31m${worktree.error}\x1b[0m`);
  }

  console.log(`  Created:    ${worktree.created_at} (${formatAge(worktree.created_at)})`);
  console.log(`  Updated:    ${worktree.updated_at} (${formatAge(worktree.updated_at)})`);

  // Run history: look up spec runs for the primary spec
  const specEntry = getSpecEntryByPath(db, worktree.spec_path);
  if (specEntry) {
    const runs = getSpecRunsByEntry(db, specEntry.id);
    if (runs.length > 0) {
      console.log(`\n  ${BOLD}Run History${RESET} ${DIM}(${runs.length} runs)${RESET}`);
      console.log(`  ${DIM}${'─'.repeat(50)}${RESET}`);

      let totalCost = 0;
      let totalDuration = 0;

      for (const run of runs) {
        const runIcon = run.status === 'passed' || run.status === 'success'
          ? '\x1b[32m+\x1b[0m'
          : '\x1b[31mx\x1b[0m';
        const cost = run.cost_usd != null ? `$${run.cost_usd.toFixed(2)}` : '   -';
        const dur = run.duration_seconds != null ? formatDuration(run.duration_seconds) : '-';
        const turns = run.num_turns != null ? `${run.num_turns}t` : '';

        totalCost += run.cost_usd ?? 0;
        totalDuration += run.duration_seconds ?? 0;

        console.log(`  ${runIcon} ${run.timestamp.substring(0, 19)}  ${cost.padStart(7)}  ${dur.padStart(6)}  ${turns}`);
      }

      console.log(`  ${DIM}${'─'.repeat(50)}${RESET}`);
      console.log(`  Total cost: ${BOLD}$${totalCost.toFixed(2)}${RESET}  Duration: ${BOLD}${formatDuration(totalDuration)}${RESET}`);
    }
  }

  // Read and display spec content for the primary spec
  try {
    const { readFileSync } = await import('fs');
    const specFullPath = path.isAbsolute(worktree.spec_path)
      ? worktree.spec_path
      : path.join(workingDir, worktree.spec_path);
    const content = readFileSync(specFullPath, 'utf-8');

    console.log(`\n  ${BOLD}Spec Content${RESET}`);
    console.log(`  ${DIM}${'─'.repeat(50)}${RESET}`);

    const lines = content.split('\n');
    const maxLines = 30;
    const displayed = lines.slice(0, maxLines);
    for (const line of displayed) {
      console.log(`  ${DIM}${line}${RESET}`);
    }
    if (lines.length > maxLines) {
      console.log(`  ${DIM}... (${lines.length - maxLines} more lines)${RESET}`);
    }
  } catch {
    // Spec file not readable — skip content display
  }

  console.log('');
}

// ── Mark-ready command ───────────────────────────────────────

export interface WorktreeMarkReadyOptions {
  cwd?: string;
  quiet?: boolean;
}

export async function markWorktreeReady(id: string, options: WorktreeMarkReadyOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const db = getDb(workingDir);

  if (!db) {
    console.error('Database unavailable.');
    process.exit(1);
  }

  const worktree = getWorktree(db, id);
  if (!worktree) {
    console.error(`Worktree not found: ${id}`);
    process.exit(1);
  }

  try {
    const { previousStatus } = transitionWorktreeStatus(db, id, 'ready');
    if (!options.quiet) {
      console.log(`Worktree ${id.substring(0, 8)}: ${previousStatus} -> ready`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ── Prune command ────────────────────────────────────────────

export interface WorktreePruneOptions {
  cwd?: string;
  dryRun?: boolean;
  force?: boolean;
  quiet?: boolean;
  /** Trigger auto-prune logic: only prune merged worktrees when above 80% disk threshold. */
  auto?: boolean;
}

/** Result of a single worktree prune operation. */
interface PruneAction {
  worktree: WorktreeRow;
  reason: string;
}

/**
 * Check if a process is alive using signal 0.
 * Returns true if the process exists and is running.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect stale worktrees and mark them as failed.
 *
 * Two strategies (mirroring markStaleTasks in db.ts):
 * 1. PID liveness: Running worktrees whose pid is no longer alive.
 * 2. TTL-based: Non-terminal worktrees older than the configured threshold.
 */
function detectAndMarkStale(
  db: ReturnType<typeof getDb> & {},
  worktrees: WorktreeRow[],
  ttlMs: number,
): { markedStale: WorktreeRow[] } {
  const markedStale: WorktreeRow[] = [];
  const now = Date.now();

  for (const w of worktrees) {
    // Strategy 1: PID liveness — running worktrees with dead processes
    if (w.status === 'running' && w.pid != null) {
      if (!isPidAlive(w.pid)) {
        updateWorktreeStatus(db, w.id, 'failed', `Stale: process ${w.pid} no longer alive`);
        markedStale.push(w);
        continue;
      }
    }

    // Strategy 2: TTL-based — non-running, non-terminal worktrees past threshold
    const terminalStatuses: WorktreeStatus[] = ['merged', 'cleaned'];
    const activeStatuses: WorktreeStatus[] = ['running', 'auditing', 'proofing', 'merging'];
    if (!terminalStatuses.includes(w.status) && !activeStatuses.includes(w.status)) {
      const age = now - new Date(w.updated_at).getTime();
      if (age > ttlMs) {
        updateWorktreeStatus(db, w.id, 'failed', `Stale: inactive for more than ${Math.floor(ttlMs / 86400000)}d`);
        markedStale.push(w);
      }
    }
  }

  return { markedStale };
}

/**
 * Prune worktrees that are merged, cleaned, or (with --force) any non-running status.
 *
 * Steps per worktree:
 * 1. Remove the git worktree directory (git worktree remove + prune)
 * 2. Delete the branch with safe delete (-d, not -D)
 * 3. Update registry status to 'cleaned'
 */
export async function pruneWorktrees(options: WorktreePruneOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();

  // ── Auto mode: delegate to threshold-based auto-prune logic ──
  if (options.auto) {
    const result = await autoPruneMergedWorktrees(workingDir, options.quiet);
    if (!result.attempted) {
      if (!options.quiet) {
        console.log('Disk usage is below the auto-prune threshold. Nothing to prune.');
      }
    }
    return;
  }

  const db = getDb(workingDir);

  if (!db) {
    console.error('Database unavailable.');
    process.exit(1);
  }

  const config = getConfig(workingDir);
  const ttlMs = config.worktreePruneTtlDays * 24 * 60 * 60 * 1000;

  // Fetch all worktrees for stale detection
  const allWorktrees = listWorktrees(db);

  if (allWorktrees.length === 0) {
    if (!options.quiet) {
      console.log('No worktrees found.');
    }
    return;
  }

  // ── Stale detection ────────────────────────────────────────
  const { markedStale } = detectAndMarkStale(db, allWorktrees, ttlMs);
  if (markedStale.length > 0 && !options.quiet) {
    console.log(`\n${BOLD}Stale detection${RESET}`);
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    for (const w of markedStale) {
      console.log(`  x ${w.id.substring(0, 8)}  ${path.basename(w.spec_path)}  ${w.status} -> failed  (pid ${w.pid ?? '-'})`);
    }
  }

  // Refresh worktree list after stale marking (statuses may have changed)
  const refreshed = listWorktrees(db);

  // ── Determine what to prune ────────────────────────────────
  const prunableStatuses: Set<WorktreeStatus> = options.force
    ? new Set(['created', 'complete', 'failed', 'audited', 'proofed', 'ready', 'paused', 'merge_failed', 'merged', 'cleaned'])
    : new Set<WorktreeStatus>(['merged', 'cleaned']);

  // Never prune actively running worktrees
  const activeStatuses: Set<WorktreeStatus> = new Set(['running', 'auditing', 'proofing', 'merging']);

  const actions: PruneAction[] = [];
  for (const w of refreshed) {
    if (activeStatuses.has(w.status)) continue;

    if (prunableStatuses.has(w.status)) {
      const reason = options.force && w.status !== 'merged' && w.status !== 'cleaned'
        ? `force (status: ${w.status})`
        : w.status;
      actions.push({ worktree: w, reason });
    }
  }

  if (actions.length === 0) {
    if (!options.quiet) {
      console.log('\nNothing to prune.');
    }
    return;
  }

  // ── Display plan ───────────────────────────────────────────
  if (!options.quiet) {
    const label = options.dryRun ? 'Would prune' : 'Pruning';
    console.log(`\n${BOLD}${label}${RESET} ${DIM}(${actions.length} worktrees)${RESET}`);
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
  }

  let pruned = 0;
  let branchesDeleted = 0;
  let errors = 0;

  for (const { worktree: w, reason } of actions) {
    const id = w.id.substring(0, 8);
    const spec = path.basename(w.spec_path);

    if (options.dryRun) {
      if (!options.quiet) {
        console.log(`  - ${id}  ${spec.padEnd(24)}  ${DIM}${reason}${RESET}  ${DIM}${w.branch}${RESET}`);
      }
      continue;
    }

    // ── Execute prune ──────────────────────────────────────
    try {
      // 1. Remove the git worktree directory
      await cleanupWorktree(w.worktree_path, workingDir, { runTeardown: true, quiet: true });

      // 2. Safe-delete the branch (-d requires merge, not -D)
      let branchDeleted = false;
      try {
        await execAsync(`git branch -d "${w.branch}"`, { cwd: workingDir });
        branchDeleted = true;
        branchesDeleted++;
      } catch {
        // Branch may not exist or may not be fully merged -- best effort
      }

      // 3. Update registry status to cleaned (if not already)
      if (w.status !== 'cleaned') {
        updateWorktreeStatus(db, w.id, 'cleaned');
      }

      pruned++;

      if (!options.quiet) {
        const branchNote = branchDeleted ? '' : `  ${DIM}(branch kept)${RESET}`;
        console.log(`  + ${id}  ${spec.padEnd(24)}  ${DIM}${reason}${RESET}${branchNote}`);
      }
    } catch (err) {
      errors++;
      if (!options.quiet) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  x ${id}  ${spec.padEnd(24)}  \x1b[31m${msg}\x1b[0m`);
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────
  if (!options.quiet) {
    if (options.dryRun) {
      console.log(`\n  ${DIM}${actions.length} worktrees would be pruned. Run without --dry-run to execute.${RESET}`);
    } else {
      const parts: string[] = [];
      parts.push(`${pruned} pruned`);
      if (branchesDeleted > 0) parts.push(`${branchesDeleted} branches deleted`);
      if (errors > 0) parts.push(`${errors} errors`);
      console.log(`\n  ${DIM}${parts.join(', ')}${RESET}`);
    }
    console.log('');
  }
}

// ── Repair command ──────────────────────────────────────────

export interface WorktreeRepairOptions {
  cwd?: string;
  /** Apply repairs. Default is dry-run (scan only). */
  fix?: boolean;
  quiet?: boolean;
}

/** A single issue detected during repair scan. */
interface RepairIssue {
  type: 'missing_directory' | 'git_deregistered' | 'stale_lock' | 'orphaned_directory';
  description: string;
  worktreeId?: string;
  path?: string;
  branch?: string;
  fixed: boolean;
  skipped?: boolean;
  skipReason?: string;
}

/** Parsed entry from `git worktree list --porcelain`. */
interface GitWorktreeInfo {
  path: string;
  branch: string;
  locked: boolean;
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 * Each entry includes the worktree path, branch name, and lock status.
 */
async function parseGitWorktreeList(repoDir: string): Promise<GitWorktreeInfo[]> {
  const result: GitWorktreeInfo[] = [];
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', { cwd: repoDir });
    let current: Partial<GitWorktreeInfo> | null = null;

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('worktree ')) {
        // Push previous entry if any
        if (current?.path) {
          result.push({
            path: current.path,
            branch: current.branch || '',
            locked: current.locked || false,
          });
        }
        current = { path: trimmed.substring('worktree '.length), locked: false };
      } else if (trimmed.startsWith('branch refs/heads/') && current) {
        current.branch = trimmed.substring('branch refs/heads/'.length);
      } else if ((trimmed === 'locked' || trimmed.startsWith('locked ')) && current) {
        current.locked = true;
      }
    }
    // Push the last entry
    if (current?.path) {
      result.push({
        path: current.path,
        branch: current.branch || '',
        locked: current.locked || false,
      });
    }
  } catch {
    // If git worktree list fails, return empty
  }
  return result;
}

/** Check if a filesystem path exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan all worktree registry entries and check filesystem + git state consistency.
 * Detects: missing directories, git-deregistered worktrees, stale locks, orphaned directories.
 *
 * Non-destructive by default (dry-run). Use --fix to apply repairs.
 * Idempotent: running multiple times produces the same result.
 */
export async function repairWorktrees(options: WorktreeRepairOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const db = getDb(workingDir);

  if (!db) {
    console.error('Database unavailable.');
    process.exit(1);
  }

  const fix = !!options.fix;
  const quiet = !!options.quiet;
  const issues: RepairIssue[] = [];

  // Get repo root
  let repoRoot: string;
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: workingDir });
    repoRoot = stdout.trim();
  } catch {
    console.error('Not a git repository.');
    process.exit(1);
    return;
  }

  // Get all worktrees from registry
  const allWorktrees = listWorktrees(db);

  // Get git worktree list
  const gitWorktreeInfos = await parseGitWorktreeList(repoRoot);
  const gitWorktreePaths = new Set(gitWorktreeInfos.map(i => i.path));

  const checked = allWorktrees.length;

  if (!quiet) {
    const mode = fix ? 'Repairing' : 'Scanning (dry-run)';
    console.log(`\n${BOLD}Worktree Repair${RESET} ${DIM}-- ${mode}${RESET}`);
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
  }

  // ── 1. Missing directories ─────────────────────────────────
  // Registry entry exists but worktree directory is gone.
  // Skip terminal status (cleaned) where directory removal is expected.

  for (const w of allWorktrees) {
    if (w.status === 'cleaned') continue;

    if (!(await pathExists(w.worktree_path))) {
      const issue: RepairIssue = {
        type: 'missing_directory',
        description: `Registry entry ${w.id.substring(0, 8)} points to missing directory: ${w.worktree_path}`,
        worktreeId: w.id,
        path: w.worktree_path,
        branch: w.branch,
        fixed: false,
      };

      if (fix) {
        updateWorktreeStatus(db, w.id, 'failed', 'Directory missing from filesystem');
        issue.fixed = true;
      }

      issues.push(issue);
    }
  }

  // ── 2. Git worktree deregistered ───────────────────────────
  // Directory exists but `git worktree list` doesn't include it.
  // Recovery: backup -> fresh worktree from branch -> rsync contents -> remove backup.

  for (const w of allWorktrees) {
    if (w.status === 'cleaned') continue;

    // Only check worktrees whose directory exists
    if (!(await pathExists(w.worktree_path))) continue;

    // If git knows about it, no issue
    if (gitWorktreePaths.has(w.worktree_path)) continue;

    const issue: RepairIssue = {
      type: 'git_deregistered',
      description: `Directory exists but not in git worktree list: ${w.worktree_path} (branch: ${w.branch})`,
      worktreeId: w.id,
      path: w.worktree_path,
      branch: w.branch,
      fixed: false,
    };

    if (fix) {
      // Check if branch still exists in the main repo
      let branchExists = false;
      try {
        await execAsync(`git rev-parse --verify "refs/heads/${w.branch}"`, { cwd: repoRoot });
        branchExists = true;
      } catch {
        // Branch doesn't exist
      }

      if (!branchExists) {
        issue.skipped = true;
        issue.skipReason = `Branch '${w.branch}' no longer exists -- manual intervention needed`;
      } else {
        const backupPath = `${w.worktree_path}.bak`;
        try {
          // (1) Rename orphaned directory to backup
          await fs.rename(w.worktree_path, backupPath);

          // (2) Create fresh worktree from existing branch
          await execAsync(`git worktree add "${w.worktree_path}" "${w.branch}"`, { cwd: repoRoot });

          // (3) Rsync contents from backup, excluding .git (preserves untracked + modified files)
          await execAsync(
            `rsync -a --exclude=.git "${backupPath}/" "${w.worktree_path}/"`,
            { cwd: repoRoot },
          );

          // (4) Remove backup
          await fs.rm(backupPath, { recursive: true, force: true });

          issue.fixed = true;
        } catch (err) {
          // Attempt to restore backup if recovery failed mid-way
          try {
            if (!(await pathExists(w.worktree_path))) {
              await fs.rename(backupPath, w.worktree_path);
            } else {
              // Fresh worktree was created but rsync failed -- clean up backup
              await fs.rm(backupPath, { recursive: true, force: true }).catch(() => {});
            }
          } catch {
            // Best effort restoration
          }

          issue.skipped = true;
          issue.skipReason = `Recovery failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    issues.push(issue);
  }

  // ── 3. Stale locks ────────────────────────────────────────
  // Locked worktrees from crashed processes.

  // Skip the first entry (main worktree) -- it can't be locked via git worktree lock
  const linkedWorktrees = gitWorktreeInfos.slice(1);

  for (const info of linkedWorktrees) {
    if (!info.locked) continue;

    const issue: RepairIssue = {
      type: 'stale_lock',
      description: `Stale lock on worktree: ${info.path}${info.branch ? ` (branch: ${info.branch})` : ''}`,
      path: info.path,
      branch: info.branch,
      fixed: false,
    };

    if (fix) {
      try {
        await execAsync(`git worktree unlock "${info.path}"`, { cwd: repoRoot });
        issue.fixed = true;
      } catch (err) {
        issue.skipped = true;
        issue.skipReason = `Unlock failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    issues.push(issue);
  }

  // ── 4. Orphaned directories ───────────────────────────────
  // Sibling directories matching forge naming pattern but not in the registry.

  const projectName = path.basename(repoRoot);
  const parentDir = path.dirname(repoRoot);
  const registeredPaths = new Set(allWorktrees.map(w => w.worktree_path));

  try {
    const entries = await fs.readdir(parentDir, { withFileTypes: true });
    const forgePrefix = `${projectName}-`;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(forgePrefix)) continue;

      const fullPath = path.join(parentDir, entry.name);

      // Skip if the repo root itself
      if (fullPath === repoRoot) continue;

      // Skip if already registered
      if (registeredPaths.has(fullPath)) continue;

      // Check if it looks like a git worktree (.git is a file, not a directory)
      let looksLikeWorktree = false;
      try {
        const gitPath = path.join(fullPath, '.git');
        const stat = await fs.stat(gitPath);
        looksLikeWorktree = stat.isFile();
      } catch {
        // No .git -- stale remnant
      }

      const desc = looksLikeWorktree
        ? `Orphaned worktree directory not in registry: ${fullPath}`
        : `Orphaned directory matches forge pattern: ${fullPath}`;

      const issue: RepairIssue = {
        type: 'orphaned_directory',
        description: desc,
        path: fullPath,
        fixed: false,
      };

      if (fix) {
        if (looksLikeWorktree) {
          // Remove via git worktree remove
          try {
            await execAsync(`git worktree remove "${fullPath}" --force`, { cwd: repoRoot });
            issue.fixed = true;
          } catch {
            // Fallback: manual cleanup
            try {
              await fs.rm(fullPath, { recursive: true, force: true });
              await execAsync('git worktree prune', { cwd: repoRoot });
              issue.fixed = true;
            } catch (err) {
              issue.skipped = true;
              issue.skipReason = `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
        } else {
          // Not a git worktree -- just remove the directory
          try {
            await fs.rm(fullPath, { recursive: true, force: true });
            issue.fixed = true;
          } catch (err) {
            issue.skipped = true;
            issue.skipReason = `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }

      issues.push(issue);
    }
  } catch {
    // Can't read parent directory -- skip orphan detection
  }

  // ── Summary ───────────────────────────────────────────────

  if (!quiet) {
    if (issues.length === 0) {
      console.log(`\n  ${checked} worktrees checked, 0 issues found.`);
    } else {
      console.log('');
      for (const issue of issues) {
        let icon: string;
        let suffix = '';

        if (issue.fixed) {
          icon = '\x1b[32m+\x1b[0m';
          suffix = ` ${DIM}(fixed)${RESET}`;
        } else if (issue.skipped) {
          icon = '\x1b[33m~\x1b[0m';
          suffix = ` ${DIM}(skipped: ${issue.skipReason})${RESET}`;
        } else {
          icon = '\x1b[31mx\x1b[0m';
        }

        console.log(`  ${icon} [${issue.type}] ${issue.description}${suffix}`);
      }

      const fixed = issues.filter(i => i.fixed).length;
      const skipped = issues.filter(i => i.skipped).length;

      console.log(`\n  ${checked} worktrees checked, ${issues.length} issues found, ${fixed} fixed`);

      if (!fix && issues.length > 0) {
        console.log(`  ${DIM}Run with --fix to apply repairs.${RESET}`);
      }
      if (skipped > 0) {
        console.log(`  ${DIM}${skipped} issues skipped (manual intervention needed).${RESET}`);
      }
    }
    console.log('');
  }
}
