// ── Consolidate Command ──────────────────────────────────────
//
// Merges all `ready` worktrees from a work group into a single
// consolidation branch. Worktrees are merged in dependency order
// with incremental type-checking after each merge. A full test
// suite runs after all merges complete. On success, a PR to main
// is created via `gh pr create`.

import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import {
  getDb,
  getWorktreesByWorkGroup,
  transitionWorktreeStatus,
  listWorktrees,
  acquireConsolidationLock,
  releaseConsolidationLock,
} from './db.js';
import type { WorktreeRow } from './db.js';
import { execAsync, resolveWorkingDir, resolveConfig, detectPackageManager } from './utils.js';
import type { PackageManager } from './utils.js';
import { loadSpecDeps, topoSort, parseScope } from './deps.js';
import type { SpecDep, DepLevel } from './deps.js';
import { detectVerification, detectMonorepo, determineAffectedPackages, runVerification } from './verify.js';
import { runQuery } from './core.js';
import { DIM, RESET, BOLD, showBanner, createInlineSpinner } from './display.js';
import { loadManifest } from './specs.js';
import { setupWorktree } from './workspace.js';

// ── Types ────────────────────────────────────────────────────

export interface ConsolidateOptions {
  workGroupId?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  verbose?: boolean;
  quiet?: boolean;
  dryRun?: boolean;
}

export interface ConsolidateResult {
  consolidationBranch: string;
  merged: string[];       // worktree IDs that were merged
  paused: string[];       // worktree IDs paused due to unresolvable conflicts
  skipped: string[];      // worktree IDs skipped due to dependency on paused/failed
  failed: string[];       // worktree IDs that failed to merge (type errors, git errors)
  prUrl?: string;
  totalCostUsd: number;
}

// ── Auto-detect Work Group ──────────────────────────────────

/**
 * Find the most recent work group that has `ready` worktrees.
 * Queries all worktrees with status=ready, groups by work_group_id,
 * returns the group with the most recent created_at.
 */
function autoDetectWorkGroup(db: ReturnType<typeof getDb>): string | null {
  if (!db) return null;

  const readyWorktrees = listWorktrees(db, 'ready');
  if (readyWorktrees.length === 0) return null;

  // Group by work_group_id, find the one with the newest worktree
  const groups = new Map<string, WorktreeRow[]>();
  for (const wt of readyWorktrees) {
    if (!wt.work_group_id) continue;
    const existing = groups.get(wt.work_group_id) || [];
    existing.push(wt);
    groups.set(wt.work_group_id, existing);
  }

  if (groups.size === 0) return null;

  // Return the group with the most recent created_at (worktrees are ordered DESC)
  let bestGroup: string | null = null;
  let bestTime = '';
  for (const [groupId, worktrees] of groups) {
    // readyWorktrees is ordered by created_at DESC, so first entry is newest
    const newest = worktrees[0].created_at;
    if (newest > bestTime) {
      bestTime = newest;
      bestGroup = groupId;
    }
  }

  return bestGroup;
}

// ── Build Dependency Order ──────────────────────────────────

/**
 * Build SpecDep entries from worktree rows by reading their spec files.
 * Returns specs in dependency order (topologically sorted levels).
 */
async function buildMergeOrder(
  worktrees: WorktreeRow[],
  workingDir: string,
): Promise<{ levels: DepLevel[]; specToWorktree: Map<string, WorktreeRow> }> {
  const specToWorktree = new Map<string, WorktreeRow>();
  const specFilePaths: string[] = [];
  const specFileNames: string[] = [];

  for (const wt of worktrees) {
    const specPath = wt.spec_path;
    const specName = path.basename(specPath);
    const fullPath = path.resolve(workingDir, specPath);

    specToWorktree.set(specName, wt);
    specFilePaths.push(fullPath);
    specFileNames.push(specName);
  }

  // Load dependencies from spec files
  let specDeps: SpecDep[];
  try {
    specDeps = await loadSpecDeps(specFilePaths, specFileNames);
  } catch {
    // If spec files are missing or unreadable, fall back to flat order
    specDeps = specFileNames.map((name, i) => ({
      name,
      path: specFilePaths[i],
      depends: [],
    }));
  }

  // Load manifest for dependency resolution
  let manifest;
  try {
    manifest = await loadManifest(workingDir);
  } catch {
    manifest = undefined;
  }

  // Topological sort -- specs with no deps come first
  const levels = topoSort(specDeps, manifest);

  return { levels, specToWorktree };
}

// ── Incremental Type Check ──────────────────────────────────

/** Build a `tsc --noEmit` command using the detected package manager runner. */
function tscRunnerCommand(pm: PackageManager | null): string {
  switch (pm) {
    case 'bun':  return 'bun run tsc --noEmit';
    case 'pnpm': return 'pnpm exec tsc --noEmit';
    case 'yarn': return 'yarn tsc --noEmit';
    case 'npm':  return 'npx tsc --noEmit';
    default:     return 'npx tsc --noEmit';
  }
}

/**
 * Run a single tsc --noEmit command in the given directory.
 * Returns { passed, errors }. The `label` is used for spinner display context.
 */
async function runTscAt(
  cmd: string,
  cwd: string,
  quiet: boolean,
  label?: string,
): Promise<{ passed: boolean; errors: string }> {
  const displayLabel = label ? `${cmd} ${DIM}(${label})${RESET}` : cmd;

  let spinner: ReturnType<typeof createInlineSpinner> | null = null;
  if (!quiet) {
    spinner = createInlineSpinner(`${DIM}[Verify]${RESET} ${displayLabel}`);
    spinner.start();
  }

  try {
    await execAsync(cmd, { cwd, timeout: 120000 });
    if (spinner) spinner.stop(`${DIM}[Verify]${RESET} \x1b[32m+\x1b[0m ${displayLabel}`);
    return { passed: true, errors: '' };
  } catch (err) {
    const error = err as { stderr?: string; stdout?: string; message?: string };
    const errorOutput = error.stderr || error.stdout || error.message || 'Unknown error';
    if (spinner) spinner.stop(`${DIM}[Verify]${RESET} \x1b[31mx\x1b[0m ${displayLabel}`);
    const context = label ? ` (in ${label})` : '';
    return { passed: false, errors: `Command failed: ${cmd}${context}\n${errorOutput}` };
  }
}

/**
 * Run an incremental type check (tsc --noEmit or equivalent).
 * Only checks types, not full build+test (that runs after all merges).
 *
 * When `scope` is provided (package directory relative to repo root):
 *   1. If the scoped dir has a tsconfig.json, run tsc there first.
 *      - On failure, return scoped errors immediately (actionable, no need for root).
 *      - On success, fall through to root check.
 *   2. If a root tsconfig.json exists, run tsc at root (catches cross-package issues).
 *
 * When no scope is provided, behavior is unchanged: detectVerification() at root.
 */
async function runIncrementalTypeCheck(
  workingDir: string,
  quiet: boolean,
  scope?: string,
): Promise<{ passed: boolean; errors: string }> {
  // ── Package-scoped type-check (monorepo optimization) ───
  if (scope) {
    const scopedDir = path.join(workingDir, scope);
    let hasScopedTsconfig = false;
    try {
      await fs.access(path.join(scopedDir, 'tsconfig.json'));
      hasScopedTsconfig = true;
    } catch {
      // No tsconfig in scoped dir -- fall through to default behavior
    }

    if (hasScopedTsconfig) {
      const pm = await detectPackageManager(workingDir);
      const tscCmd = tscRunnerCommand(pm);

      // Run scoped type-check
      const scopedResult = await runTscAt(tscCmd, scopedDir, quiet, scope);
      if (!scopedResult.passed) {
        // Scoped errors are actionable -- return immediately
        return scopedResult;
      }

      // Scoped passed -- check root tsconfig for cross-package issues
      let hasRootTsconfig = false;
      try {
        await fs.access(path.join(workingDir, 'tsconfig.json'));
        hasRootTsconfig = true;
      } catch {
        // No root tsconfig -- scoped check was sufficient
      }

      if (hasRootTsconfig) {
        return runTscAt(tscCmd, workingDir, quiet);
      }

      return { passed: true, errors: '' };
    }
    // No scoped tsconfig -- fall through to default detection
  }

  // ── Default: detect verification at root (existing behavior) ─
  const commands = await detectVerification(workingDir);

  // Find type-check command (tsc --noEmit or equivalent)
  const typeCheckCmd = commands.find(cmd => cmd.includes('tsc --noEmit'));
  if (!typeCheckCmd) {
    // No type-check command detected -- skip (not a TypeScript project)
    return { passed: true, errors: '' };
  }

  return runTscAt(typeCheckCmd, workingDir, quiet);
}

// ── SDK Agent for Type Error Fixing ─────────────────────────

/**
 * Dispatch an SDK agent to fix type errors after a merge.
 * Returns true if the agent fixed the errors, false otherwise.
 */
async function fixTypeErrors(
  workingDir: string,
  errors: string,
  branch: string,
  model: string,
  maxTurns: number,
  maxBudgetUsd: number,
  quiet: boolean,
  verbose: boolean,
  scope?: string,
): Promise<{ fixed: boolean; costUsd: number }> {
  const scopeContext = scope
    ? `\n\n## Scope\n\nThe errors originate from the \`${scope}\` package. Focus your fixes on files within that package directory first. Cross-package type issues may also need attention at the repo root.`
    : '';

  const prompt = `Fix the following TypeScript type errors that occurred after merging branch "${branch}" during consolidation.

The consolidation branch has type errors that need to be resolved. Fix ALL type errors without changing the intended behavior of the merged code.${scopeContext}

## Type Errors

${errors}

## Instructions

1. Read the files mentioned in the errors
2. Fix all type errors by making minimal, targeted changes
3. Ensure the fix preserves the intended behavior
4. Run the type checker to verify all errors are resolved`;

  try {
    const result = await runQuery({
      prompt,
      workingDir,
      model,
      maxTurns,
      maxBudgetUsd,
      verbose,
      quiet,
      silent: false,
      sessionExtra: { type: 'consolidate-fix' },
    });

    // Verify the fix worked
    const recheck = await runIncrementalTypeCheck(workingDir, quiet, scope);
    return { fixed: recheck.passed, costUsd: result.costUsd ?? 0 };
  } catch {
    return { fixed: false, costUsd: 0 };
  }
}

// ── SDK Agent for Merge Conflict Resolution ─────────────────

/**
 * Dispatch an SDK agent to resolve git merge conflicts.
 * The agent receives the conflicted files, spec content, and diff context.
 * It edits the conflicted files and stages the resolution.
 * Returns true if all conflicts were resolved (no remaining unmerged files).
 */
async function resolveConflicts(
  consolidationPath: string,
  wt: WorktreeRow,
  specContent: string,
  model: string,
  maxTurns: number,
  maxBudgetUsd: number,
  quiet: boolean,
  verbose: boolean,
): Promise<{ resolved: boolean; costUsd: number }> {
  // Get conflicted files
  let conflictedFileList = '';
  try {
    const { stdout } = await execAsync(
      'git diff --name-only --diff-filter=U',
      { cwd: consolidationPath },
    );
    conflictedFileList = stdout.trim();
  } catch {
    return { resolved: false, costUsd: 0 };
  }

  if (!conflictedFileList) {
    return { resolved: false, costUsd: 0 };
  }

  // Get the conflict diff for context
  let conflictDiff = '';
  try {
    const { stdout } = await execAsync('git diff', { cwd: consolidationPath });
    conflictDiff = stdout;
  } catch {
    // Best effort -- proceed without diff
  }

  const prompt = `Resolve the following git merge conflicts that occurred while merging branch "${wt.branch}" during consolidation.

## Conflicted Files

${conflictedFileList}

## Conflict Diff

\`\`\`
${conflictDiff.substring(0, 10000)}
\`\`\`

## Original Spec

${specContent}

## Instructions

1. Read each conflicted file listed above
2. Resolve ALL merge conflicts by editing the files -- preserve the intent from both sides
3. Stage ALL resolved files with \`git add <file>\`
4. Do NOT commit -- the consolidation process will handle the commit
5. Ensure the resolution compiles (run the type checker if available)`;

  try {
    const result = await runQuery({
      prompt,
      workingDir: consolidationPath,
      model,
      maxTurns,
      maxBudgetUsd,
      verbose,
      quiet,
      silent: false,
      sessionExtra: { type: 'consolidate-conflict-resolve', branch: wt.branch },
    });

    // Check if all conflicts are resolved (no remaining unmerged files)
    try {
      const { stdout: remaining } = await execAsync(
        'git diff --name-only --diff-filter=U',
        { cwd: consolidationPath },
      );
      if (remaining.trim()) {
        return { resolved: false, costUsd: result.costUsd ?? 0 };
      }
    } catch {
      return { resolved: false, costUsd: result.costUsd ?? 0 };
    }

    return { resolved: true, costUsd: result.costUsd ?? 0 };
  } catch {
    return { resolved: false, costUsd: 0 };
  }
}

// ── Merge Single Worktree ───────────────────────────────────

interface MergeAttemptResult {
  success: boolean;
  /** True when the worktree was paused due to unresolvable git conflicts */
  paused?: boolean;
  costUsd: number;
  error?: string;
  /** Conflicted file paths (populated when paused) */
  conflictedFiles?: string[];
}

/**
 * Merge a single worktree branch into the consolidation worktree.
 * Handles: git merge, conflict resolution via SDK agent, incremental
 * type-check, and optional SDK fix for type errors.
 */
async function mergeWorktreeBranch(
  consolidationPath: string,
  wt: WorktreeRow,
  db: ReturnType<typeof getDb>,
  model: string,
  maxTurns: number,
  maxBudgetUsd: number,
  quiet: boolean,
  verbose: boolean,
  specContent: string,
): Promise<MergeAttemptResult> {
  if (!db) return { success: false, costUsd: 0, error: 'Database unavailable' };

  const branch = wt.branch;
  let totalCost = 0;

  // Parse optional scope from spec frontmatter for package-scoped type-checking
  const scope = specContent ? parseScope(specContent) : undefined;

  // Transition: ready -> merging
  transitionWorktreeStatus(db, wt.id, 'merging');

  // Attempt the merge
  try {
    await execAsync(
      `git merge --no-ff "${branch}" -m "forge: consolidate ${branch}"`,
      { cwd: consolidationPath },
    );
  } catch (err) {
    const error = err as { stderr?: string; stdout?: string; message?: string };
    const errorOutput = error.stderr || error.stdout || error.message || 'Unknown error';

    // Check if this is a git conflict (vs other git errors)
    if (errorOutput.includes('CONFLICT') || errorOutput.includes('Merge conflict')) {
      // Get the list of conflicted files for context and error reporting
      let conflictedFiles: string[] = [];
      try {
        const { stdout: conflictOutput } = await execAsync(
          'git diff --name-only --diff-filter=U',
          { cwd: consolidationPath },
        );
        conflictedFiles = conflictOutput.trim().split('\n').filter(f => f.length > 0);
      } catch {
        // Best effort
      }

      if (!quiet) {
        console.log(`\n${DIM}[forge]${RESET} Merge conflict in ${branch} (${conflictedFiles.length} file${conflictedFiles.length !== 1 ? 's' : ''}) -- dispatching resolution agent`);
      }

      // Dispatch SDK agent to resolve conflicts
      const resolveResult = await resolveConflicts(
        consolidationPath, wt, specContent, model, maxTurns, maxBudgetUsd, quiet, verbose,
      );
      totalCost += resolveResult.costUsd;

      if (resolveResult.resolved) {
        // Conflicts resolved -- complete the merge commit
        let commitSucceeded = false;
        try {
          await execAsync('git commit --no-edit', { cwd: consolidationPath });
          commitSucceeded = true;
        } catch {
          // Commit failed after resolution
        }

        if (commitSucceeded) {
          // Type-check after conflict resolution
          const typeCheck = await runIncrementalTypeCheck(consolidationPath, quiet, scope);

          if (typeCheck.passed) {
            transitionWorktreeStatus(db, wt.id, 'merged');
            return { success: true, costUsd: totalCost };
          }

          // Type errors after conflict resolution -- try fix agent (up to 2 retries)
          if (!quiet) {
            console.log(`${DIM}[forge]${RESET} Type errors after conflict resolution -- dispatching fix agent`);
          }

          const maxConflictFixAttempts = 2;
          let conflictTypeFixed = false;
          for (let fixAttempt = 1; fixAttempt <= maxConflictFixAttempts; fixAttempt++) {
            if (!quiet) {
              console.log(`${DIM}[forge]${RESET} Fix attempt ${fixAttempt}/${maxConflictFixAttempts} for ${branch}`);
            }

            const fixResult = await fixTypeErrors(
              consolidationPath, typeCheck.errors, branch, model, maxTurns, maxBudgetUsd, quiet, verbose, scope,
            );
            totalCost += fixResult.costUsd;

            if (fixResult.fixed) {
              try {
                const { stdout: fixStatus } = await execAsync('git status --porcelain', { cwd: consolidationPath });
                if (fixStatus.trim()) {
                  await execAsync('git add -A -- . ":!.forge"', { cwd: consolidationPath });
                  await execAsync(
                    `git commit -m "forge: fix type errors after conflict resolution for ${branch}"`,
                    { cwd: consolidationPath },
                  );
                }
              } catch {
                continue;
              }
              conflictTypeFixed = true;
              break;
            }

            // Re-check errors for next attempt
            const recheck = await runIncrementalTypeCheck(consolidationPath, quiet, scope);
            if (recheck.passed) {
              conflictTypeFixed = true;
              break;
            }
          }

          if (conflictTypeFixed) {
            transitionWorktreeStatus(db, wt.id, 'merged');
            return { success: true, costUsd: totalCost };
          }

          // Could not fix type errors -- roll back the merge commit and pause
          if (!quiet) {
            console.log(`${DIM}[forge]${RESET} \x1b[31mx\x1b[0m Could not fix type errors after conflict resolution for ${branch} -- pausing`);
          }
          try {
            await execAsync('git reset --hard HEAD~1', { cwd: consolidationPath });
          } catch {
            // Best effort
          }
          const conflictList = conflictedFiles.join(', ');
          transitionWorktreeStatus(db, wt.id, 'paused', `Type errors after conflict resolution: ${conflictList}`);
          return { success: false, paused: true, costUsd: totalCost, error: `Type errors after conflict resolution for ${branch}`, conflictedFiles };
        }
      }

      // Agent could not resolve conflicts (or commit failed) -- abort and pause
      if (!quiet) {
        console.log(`${DIM}[forge]${RESET} \x1b[31mx\x1b[0m Could not resolve conflicts for ${branch} -- pausing`);
      }
      try {
        await execAsync('git merge --abort', { cwd: consolidationPath });
      } catch {
        // Best effort
      }
      const conflictList = conflictedFiles.join(', ');
      transitionWorktreeStatus(db, wt.id, 'paused', `Unresolved merge conflicts: ${conflictList}`);
      return { success: false, paused: true, costUsd: totalCost, error: `Unresolved conflicts in ${branch}`, conflictedFiles };
    }

    // Other git error
    try {
      await execAsync('git merge --abort', { cwd: consolidationPath });
    } catch {
      // Best effort
    }
    transitionWorktreeStatus(db, wt.id, 'merge_failed', errorOutput.substring(0, 500));
    return { success: false, costUsd: 0, error: `Git error merging ${branch}: ${errorOutput.substring(0, 200)}` };
  }

  // Merge succeeded (no git conflicts) -- run incremental type check
  const typeCheck = await runIncrementalTypeCheck(consolidationPath, quiet, scope);

  if (typeCheck.passed) {
    // Clean merge with passing types
    transitionWorktreeStatus(db, wt.id, 'merged');
    return { success: true, costUsd: 0 };
  }

  // Type errors after clean merge -- dispatch SDK agent (up to 2 retries)
  if (!quiet) {
    console.log(`${DIM}[forge]${RESET} Type errors after merging ${branch} -- dispatching fix agent`);
  }

  const maxFixAttempts = 2;
  for (let attempt = 1; attempt <= maxFixAttempts; attempt++) {
    if (!quiet) {
      console.log(`${DIM}[forge]${RESET} Fix attempt ${attempt}/${maxFixAttempts} for ${branch}`);
    }

    const fixResult = await fixTypeErrors(
      consolidationPath,
      typeCheck.errors,
      branch,
      model,
      maxTurns,
      maxBudgetUsd,
      quiet,
      verbose,
      scope,
    );
    totalCost += fixResult.costUsd;

    if (fixResult.fixed) {
      // Agent fixed the type errors -- commit the fix
      try {
        const { stdout: status } = await execAsync('git status --porcelain', { cwd: consolidationPath });
        if (status.trim()) {
          await execAsync('git add -A -- . ":!.forge"', { cwd: consolidationPath });
          await execAsync(
            `git commit -m "forge: fix type errors after merging ${branch}"`,
            { cwd: consolidationPath },
          );
        }
      } catch {
        // If commit fails, the fix didn't work
        continue;
      }

      transitionWorktreeStatus(db, wt.id, 'merged');
      return { success: true, costUsd: totalCost };
    }

    // Re-check errors for next attempt (they may have changed)
    const recheck = await runIncrementalTypeCheck(consolidationPath, quiet, scope);
    if (recheck.passed) {
      transitionWorktreeStatus(db, wt.id, 'merged');
      return { success: true, costUsd: totalCost };
    }
  }

  // Agent could not fix type errors -- roll back the merge
  if (!quiet) {
    console.log(`${DIM}[forge]${RESET} \x1b[31mx\x1b[0m Could not fix type errors for ${branch} -- rolling back`);
  }

  try {
    await execAsync('git reset --hard HEAD~1', { cwd: consolidationPath });
  } catch {
    // If reset fails, we're in a bad state
  }

  transitionWorktreeStatus(db, wt.id, 'merge_failed', `Type errors could not be fixed after ${maxFixAttempts} attempts`);
  return {
    success: false,
    costUsd: totalCost,
    error: `Type errors after merging ${branch} could not be fixed`,
  };
}

// ── Main Consolidate Logic ──────────────────────────────────

export async function runConsolidate(options: ConsolidateOptions): Promise<ConsolidateResult> {
  const workingDir = await resolveWorkingDir(options.cwd);
  const { model, maxTurns, maxBudgetUsd } = await resolveConfig(workingDir, {
    model: options.model,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    defaultModel: 'sonnet',
    defaultMaxTurns: 50,
    defaultMaxBudgetUsd: 20.00,
  });

  const quiet = options.quiet ?? false;
  const verbose = options.verbose ?? false;
  const dryRun = options.dryRun ?? false;

  if (!quiet) showBanner('consolidate');

  // ── Database ──────────────────────────────────────────────
  const db = getDb(workingDir);
  if (!db) {
    throw new Error('Database unavailable -- cannot run consolidate');
  }

  // ── Resolve work group ────────────────────────────────────
  let workGroupId = options.workGroupId;
  if (!workGroupId) {
    workGroupId = autoDetectWorkGroup(db) ?? undefined;
    if (!workGroupId) {
      throw new Error(
        'No work group with ready worktrees found.\n' +
        'Use --work-group <id> to specify a work group, or mark worktrees as ready first.'
      );
    }
    if (!quiet) {
      console.log(`${DIM}[forge]${RESET} Auto-detected work group: ${workGroupId}`);
    }
  }

  // ── Concurrency guard ────────────────────────────────────
  const lockResult = acquireConsolidationLock(db, workGroupId);
  if (!lockResult.acquired) {
    throw new Error(
      `Consolidation already in progress for work group ${workGroupId} (PID ${lockResult.activePid}).\n` +
      'Wait for the current consolidation to finish, or kill the process if it is stuck.'
    );
  }

  // Register Ctrl-C cleanup to release the lock
  const cleanupLock = () => {
    try {
      releaseConsolidationLock(db, workGroupId);
    } catch {
      // Best effort -- DB may already be closed
    }
  };
  process.on('exit', cleanupLock);

  // ── Discover ready worktrees ──────────────────────────────
  const allWorktrees = getWorktreesByWorkGroup(db, workGroupId);
  const readyWorktrees = allWorktrees.filter(wt => wt.status === 'ready');

  if (readyWorktrees.length === 0) {
    throw new Error(
      `No ready worktrees in work group ${workGroupId}.\n` +
      `Found ${allWorktrees.length} worktrees with statuses: ${[...new Set(allWorktrees.map(w => w.status))].join(', ')}`
    );
  }

  if (!quiet) {
    console.log(`${DIM}[forge]${RESET} Work group: ${workGroupId}`);
    console.log(`${DIM}[forge]${RESET} Ready worktrees: ${readyWorktrees.length}`);
    for (const wt of readyWorktrees) {
      console.log(`${DIM}[forge]${RESET}   ${path.basename(wt.spec_path, '.md')} (${wt.branch})`);
    }
  }

  // ── Build merge order ─────────────────────────────────────
  const { levels, specToWorktree } = await buildMergeOrder(readyWorktrees, workingDir);

  if (!quiet) {
    console.log(`${DIM}[forge]${RESET} Merge levels: ${levels.length}`);
    for (let i = 0; i < levels.length; i++) {
      const names = levels[i].specs.map(s => s.name).join(', ');
      console.log(`${DIM}[forge]${RESET}   Level ${i}: ${names}`);
    }
    console.log();
  }

  // ── Dry run ───────────────────────────────────────────────
  if (dryRun) {
    console.log(`${BOLD}Dry run -- no changes will be made${RESET}\n`);
    console.log(`Would create branch: forge/consolidate/${workGroupId}`);
    console.log(`Would merge ${readyWorktrees.length} worktrees in ${levels.length} dependency levels`);
    console.log(`Would run full verification after all merges`);
    console.log(`Would create PR to main`);
    return {
      consolidationBranch: `forge/consolidate/${workGroupId}`,
      merged: [],
      paused: [],
      skipped: [],
      failed: [],
      totalCostUsd: 0,
    };
  }

  // ── Get the main branch name ──────────────────────────────
  let mainBranch = 'main';
  try {
    const { stdout } = await execAsync(
      'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo refs/remotes/origin/main',
      { cwd: workingDir },
    );
    const ref = stdout.trim();
    mainBranch = ref.replace('refs/remotes/origin/', '');
  } catch {
    // Default to main
  }

  // ── Create consolidation branch ───────────────────────────
  const consolidationBranch = `forge/consolidate/${workGroupId}`;

  // Delete if it already exists (fresh start)
  try {
    await execAsync(`git branch -D "${consolidationBranch}"`, { cwd: workingDir });
  } catch {
    // Didn't exist -- fine
  }

  // Create the consolidation branch from main
  await execAsync(`git branch "${consolidationBranch}" "${mainBranch}"`, { cwd: workingDir });

  // ── Create a temporary worktree for the consolidation ─────
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-consolidate-'));
  // Remove the mkdtemp dir (we need git worktree add to create it)
  await fs.rm(tmpDir, { recursive: true, force: true });

  try {
    await execAsync(
      `git worktree add "${tmpDir}" "${consolidationBranch}"`,
      { cwd: workingDir },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create consolidation worktree: ${msg}`);
  }

  if (!quiet) {
    console.log(`${DIM}[forge]${RESET} Consolidation branch: ${consolidationBranch}`);
    console.log(`${DIM}[forge]${RESET} Working in: ${tmpDir}`);
    console.log();
  }

  // ── Workspace setup (install dependencies) ────────────────
  const setupResult = await setupWorktree(tmpDir, workingDir, { quiet });
  if (setupResult && !setupResult.success) {
    throw new Error(`Workspace setup failed in consolidation worktree: ${setupResult.failedCommand}`);
  }

  // ── Merge worktrees in dependency order ───────────────────
  const merged: string[] = [];
  const paused: string[] = [];    // conflict-paused worktree IDs
  const skipped: string[] = [];
  const failed: string[] = [];
  const failedSpecs = new Set<string>(); // Track failed/paused spec names for dependent skipping
  const blockedByMap = new Map<string, string>(); // specName -> blockerSpecName (for skip messages)
  let totalCost = 0;

  try {
    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      const level = levels[levelIdx];

      if (!quiet) {
        console.log(`${BOLD}Level ${levelIdx}${RESET} (${level.specs.length} spec${level.specs.length > 1 ? 's' : ''})`);
      }

      for (const spec of level.specs) {
        const wt = specToWorktree.get(spec.name);
        if (!wt) {
          if (!quiet) console.log(`  ${DIM}-${RESET} ${spec.name} (no worktree found -- skipping)`);
          continue;
        }

        // Check if any dependency failed/paused -- skip transitive dependents
        const blocker = spec.depends.find(dep => failedSpecs.has(dep));
        if (blocker) {
          // Trace back to find the root blocker
          const rootBlocker = blockedByMap.get(blocker) || blocker;
          blockedByMap.set(spec.name, rootBlocker);
          if (!quiet) {
            console.log(`  ${DIM}-${RESET} ${spec.name} (skipped -- blocked by ${rootBlocker})`);
          }
          skipped.push(wt.id);
          failedSpecs.add(spec.name); // propagate skip
          continue;
        }

        if (!quiet) {
          process.stdout.write(`  > ${spec.name}...`);
        }

        // Read spec content for conflict resolution context
        let specContent = '';
        try {
          const specFullPath = path.resolve(workingDir, wt.spec_path);
          specContent = await fs.readFile(specFullPath, 'utf-8');
        } catch {
          // Best effort -- proceed without spec content
        }

        const result = await mergeWorktreeBranch(
          tmpDir,
          wt,
          db,
          model,
          maxTurns,
          maxBudgetUsd,
          quiet,
          verbose,
          specContent,
        );

        totalCost += result.costUsd;

        if (result.success) {
          merged.push(wt.id);
          if (!quiet) {
            process.stdout.write(`\r  \x1b[32m+\x1b[0m ${spec.name}\n`);
          }
        } else if (result.paused) {
          paused.push(wt.id);
          failedSpecs.add(spec.name);
          blockedByMap.set(spec.name, spec.name); // self-blocked (root cause)
          if (!quiet) {
            process.stdout.write(`\r  \x1b[33m|\x1b[0m ${spec.name} (paused -- ${result.error || 'unresolved conflicts'})\n`);
          }
        } else {
          failed.push(wt.id);
          failedSpecs.add(spec.name);
          blockedByMap.set(spec.name, spec.name); // self-blocked (root cause)
          if (!quiet) {
            process.stdout.write(`\r  \x1b[31mx\x1b[0m ${spec.name} (${result.error || 'failed'})\n`);
          }
        }
      }

      if (!quiet && levelIdx < levels.length - 1) {
        console.log(); // space between levels
      }
    }

    if (!quiet) {
      console.log();
      const parts = [`${merged.length} merged`];
      if (paused.length > 0) parts.push(`${paused.length} paused`);
      if (failed.length > 0) parts.push(`${failed.length} failed`);
      if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
      console.log(`${DIM}[forge]${RESET} Merge summary: ${parts.join(', ')}`);
    }

    // ── Early exit if nothing was merged ──────────────────────
    if (merged.length === 0) {
      if (!quiet) {
        console.log(`\n${DIM}[forge]${RESET} No worktrees merged -- skipping verification and PR`);
      }
      return {
        consolidationBranch,
        merged,
        paused,
        skipped,
        failed,
        totalCostUsd: totalCost,
      };
    }

    // ── Full verification (build + test) ────────────────────
    if (!quiet) {
      console.log(`\n${BOLD}Verification${RESET}`);
    }

    // Collect affected packages from merged worktrees' spec scopes
    const monorepo = await detectMonorepo(tmpDir);
    if (monorepo) {
      const affectedSet = new Set<string>();
      for (const wtId of merged) {
        const wt = readyWorktrees.find(w => w.id === wtId);
        if (!wt) continue;
        try {
          const specFullPath = path.resolve(workingDir, wt.spec_path);
          const content = await fs.readFile(specFullPath, 'utf-8');
          const scope = parseScope(content);
          const affected = determineAffectedPackages(monorepo, wt.spec_path, content, workingDir, scope);
          for (const pkgName of affected) {
            affectedSet.add(pkgName);
          }
        } catch {
          // Best effort -- proceed without scope
        }
      }
      if (affectedSet.size > 0) {
        monorepo.affected = [...affectedSet];
        if (!quiet) {
          console.log(`${DIM}[forge]${RESET} Scoped to packages: ${monorepo.affected.join(', ')}`);
        }
      }
    }

    const verification = await runVerification(tmpDir, quiet, undefined, monorepo);

    if (!verification.passed) {
      if (!quiet) {
        console.log(`\n${DIM}[forge]${RESET} \x1b[31mx\x1b[0m Verification failed after consolidation`);
        console.log(`${DIM}[forge]${RESET} Errors:\n${verification.errors.substring(0, 1000)}`);
      }
      throw new Error(`Verification failed after consolidation:\n${verification.errors.substring(0, 500)}`);
    }

    if (!quiet) {
      console.log(`\n${DIM}[forge]${RESET} \x1b[32m+\x1b[0m All verification passed`);
    }

    // ── Push and create PR ──────────────────────────────────
    if (!quiet) {
      console.log(`\n${BOLD}Creating PR${RESET}`);
    }

    // Push the consolidation branch
    try {
      await execAsync(`git push -u origin "${consolidationBranch}"`, { cwd: tmpDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to push consolidation branch: ${msg}`);
    }

    // Build PR description
    const specList = merged.map(id => {
      const wt = allWorktrees.find(w => w.id === id);
      return wt ? `- ${path.basename(wt.spec_path, '.md')} (\`${wt.branch}\`)` : `- ${id}`;
    }).join('\n');

    const pausedList = paused.length > 0
      ? `\n\n## Paused (unresolved conflicts)\n${paused.map(id => {
          const wt = allWorktrees.find(w => w.id === id);
          return wt ? `- ${path.basename(wt.spec_path, '.md')}` : `- ${id}`;
        }).join('\n')}`
      : '';

    const failedList = failed.length > 0
      ? `\n\n## Failed\n${failed.map(id => {
          const wt = allWorktrees.find(w => w.id === id);
          return wt ? `- ${path.basename(wt.spec_path, '.md')}` : `- ${id}`;
        }).join('\n')}`
      : '';

    const skippedList = skipped.length > 0
      ? `\n\n## Skipped (dependency on paused/failed)\n${skipped.map(id => {
          const wt = allWorktrees.find(w => w.id === id);
          return wt ? `- ${path.basename(wt.spec_path, '.md')}` : `- ${id}`;
        }).join('\n')}`
      : '';

    const prTitle = `forge: consolidate ${workGroupId} (${merged.length} specs)`;
    const prBody = `## Summary

Consolidation of work group \`${workGroupId}\` with ${merged.length} spec${merged.length > 1 ? 's' : ''} merged in dependency order.

## Merged specs
${specList}${pausedList}${failedList}${skippedList}

## Verification

All build and test commands passed after consolidation.

---
*Generated by \`forge consolidate\`*`;

    let prUrl: string | undefined;
    try {
      const { stdout: prOutput } = await execAsync(
        `gh pr create --title "${prTitle}" --body "${prBody.replace(/"/g, '\\"')}" --base "${mainBranch}" --head "${consolidationBranch}"`,
        { cwd: tmpDir },
      );
      prUrl = prOutput.trim();
      if (!quiet) {
        console.log(`${DIM}[forge]${RESET} PR created: ${prUrl}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!quiet) {
        console.log(`${DIM}[forge]${RESET} \x1b[33mWarning:\x1b[0m Could not create PR: ${msg}`);
        console.log(`${DIM}[forge]${RESET} Branch ${consolidationBranch} has been pushed -- create PR manually`);
      }
    }

    // ── Print summary ────────────────────────────────────────
    if (!quiet) {
      console.log();
      console.log(`${BOLD}Consolidation complete${RESET}`);
      console.log(`  Branch: ${consolidationBranch}`);
      const summaryParts = [`Merged: ${merged.length}`];
      if (paused.length > 0) summaryParts.push(`Paused: ${paused.length}`);
      if (failed.length > 0) summaryParts.push(`Failed: ${failed.length}`);
      if (skipped.length > 0) summaryParts.push(`Skipped: ${skipped.length}`);
      console.log(`  ${summaryParts.join('  ')}`);
      if (totalCost > 0) {
        console.log(`  Cost:   $${totalCost.toFixed(2)}`);
      }
      if (prUrl) {
        console.log(`  PR:     ${prUrl}`);
      }
    }

    return {
      consolidationBranch,
      merged,
      paused,
      skipped,
      failed,
      prUrl,
      totalCostUsd: totalCost,
    };
  } finally {
    // ── Release consolidation lock ──────────────────────────
    releaseConsolidationLock(db, workGroupId);
    process.removeListener('exit', cleanupLock);

    // ── Clean up consolidation worktree ─────────────────────
    try {
      await execAsync(`git worktree remove "${tmpDir}" --force`, { cwd: workingDir });
    } catch {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
        await execAsync('git worktree prune', { cwd: workingDir });
      } catch {
        // Best effort cleanup
      }
    }
  }
}
