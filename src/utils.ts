import type { ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getDb, insertRun, insertWorktree, getWorktreeByPath, updateWorktreeStatus } from './db.js';
import { setupWorktree, teardownWorktree } from './workspace.js';
import { checkWorktreeLimits, autoPruneMergedWorktrees } from './worktree-limits.js';

// Custom error that carries the ForgeResult for cost tracking on failure
export class ForgeError extends Error {
  result?: ForgeResult;
  constructor(message: string, result?: ForgeResult) {
    super(message);
    this.name = 'ForgeError';
    this.result = result;
  }
}

export const execAsync = promisify(exec);

// ── Binary Resolution ────────────────────────────────────────

/**
 * Resolve the forge CLI entry point (dist/index.js) using import.meta.url.
 * Shared helper so every call site resolves the binary the same way.
 */
export function getForgeEntryPoint(): string {
  return path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'index.js'));
}

// ── Package Manager Detection ────────────────────────────────

/** Detected package manager for a Node.js project. */
export type PackageManager = 'bun' | 'pnpm' | 'npm' | 'yarn';

/**
 * Detect the package manager for a project by checking lockfiles.
 * Returns null if no package.json is found. Detection order (first match wins):
 *   bun.lockb / bun.lock  ->  bun
 *   pnpm-lock.yaml        ->  pnpm
 *   yarn.lock              ->  yarn
 *   package-lock.json      ->  npm
 *   package.json (no lock) ->  npm (default)
 *   no package.json        ->  null
 */
export async function detectPackageManager(workingDir: string): Promise<PackageManager | null> {
  const lockfiles: Array<{ file: string; pm: PackageManager }> = [
    { file: 'bun.lockb', pm: 'bun' },
    { file: 'bun.lock', pm: 'bun' },
    { file: 'pnpm-lock.yaml', pm: 'pnpm' },
    { file: 'yarn.lock', pm: 'yarn' },
    { file: 'package-lock.json', pm: 'npm' },
  ];

  for (const { file, pm } of lockfiles) {
    try {
      await fs.access(path.join(workingDir, file));
      return pm;
    } catch {
      // Not found -- try next
    }
  }

  // No lockfile found -- check for package.json (default to npm)
  try {
    await fs.access(path.join(workingDir, 'package.json'));
    return 'npm';
  } catch {
    return null;
  }
}

// ── .forge/ directory bootstrap ──────────────────────────────

const FORGE_GITIGNORE = `# Ignore everything except the manifest and pipeline state
*
!.gitignore
!specs.json
!pipeline.json
`;

/**
 * Ensure .forge/ exists and contains a .gitignore that tracks only specs.json.
 * Idempotent — skips writing if .gitignore already exists.
 */
export async function ensureForgeDir(baseDir: string): Promise<string> {
  const forgeDir = path.join(baseDir, '.forge');
  await fs.mkdir(forgeDir, { recursive: true });

  const gitignorePath = path.join(forgeDir, '.gitignore');
  try {
    await fs.access(gitignorePath);
  } catch {
    await fs.writeFile(gitignorePath, FORGE_GITIGNORE);
  }

  return forgeDir;
}

// ── Config ───────────────────────────────────────────────────

export interface ForgeConfig {
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  verify?: string[];
}

export async function loadConfig(workingDir: string): Promise<ForgeConfig> {
  try {
    const configPath = path.join(workingDir, '.forge', 'config.json');
    return JSON.parse(await fs.readFile(configPath, 'utf-8')) as ForgeConfig;
  } catch {
    return {};
  }
}

// Resolve and validate working directory
export async function resolveWorkingDir(cwd?: string): Promise<string> {
  const workingDir = cwd ? (await fs.realpath(cwd)) : process.cwd();
  try {
    const stat = await fs.stat(workingDir);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${workingDir}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Directory not found: ${workingDir}`);
    }
    throw err;
  }
  return workingDir;
}

// Load config and merge with per-command defaults
export interface ConfigOverrides {
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  defaultModel?: string;
  defaultMaxTurns?: number;
  defaultMaxBudgetUsd?: number;
}

export interface ResolvedConfig {
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  config: ForgeConfig;
}

export async function resolveConfig(workingDir: string, overrides: ConfigOverrides): Promise<ResolvedConfig> {
  const config = await loadConfig(workingDir);
  return {
    model: overrides.model || config.model || overrides.defaultModel || 'opus',
    maxTurns: overrides.maxTurns ?? config.maxTurns ?? overrides.defaultMaxTurns ?? 250,
    maxBudgetUsd: overrides.maxBudgetUsd ?? config.maxBudgetUsd ?? overrides.defaultMaxBudgetUsd ?? 50.00,
    config,
  };
}

// Resolve resume/fork session options
export function resolveSession(fork?: string, resume?: string): { effectiveResume?: string; isFork: boolean } {
  return { effectiveResume: fork || resume, isFork: !!fork };
}

// Check if an error is transient and retryable
export function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Rate limits, network errors, server errors
    return (
      message.includes('rate limit') ||
      message.includes('rate_limit') ||
      message.includes('429') ||
      message.includes('500') ||
      message.includes('503') ||
      message.includes('502') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('network') ||
      message.includes('overloaded')
    );
  }
  return false;
}

// Sleep helper for retry delays
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Work Group ID ────────────────────────────────────────────

/**
 * Generate a work group ID with format: wg-{timestamp}-{random}
 * Short enough for directory names and branch names.
 * Example: wg-1710500000-a3f2
 */
export function generateWorkGroupId(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = Math.random().toString(16).substring(2, 6);
  return `wg-${timestamp}-${random}`;
}

// ── Git Worktree Helpers ─────────────────────────────────────

/** Validate that a directory is inside a git repository. */
async function assertGitRepo(dir: string): Promise<void> {
  try {
    await execAsync('git rev-parse --git-dir', { cwd: dir });
  } catch {
    throw new Error(`--branch requires a git repository (not found in ${dir})`);
  }
}

/** Options for worktree registry integration. */
export interface WorktreeRegistryOptions {
  /** Path to the spec file (used to derive spec name for directory/branch naming) */
  spec_path?: string;
  /** Linear issue ID (e.g. "ENG-123") for directory/branch naming */
  linear_issue_id?: string;
  /** Work group ID for associating worktrees from the same session */
  work_group_id?: string;
  /** Run workspace setup hooks (lockfile install, cargo build, go mod download) after creation */
  runSetup?: boolean;
  /** Suppress console output from setup/teardown hooks */
  quiet?: boolean;
  /** Skip worktree count and disk usage limit checks */
  force?: boolean;
  /** Skip automatic pruning of merged worktrees when approaching disk limits */
  noAutoPrune?: boolean;
  /** Git ref to use as the start point for the new branch (default: HEAD) */
  startPoint?: string;
  /** Monorepo package scope (e.g. "packages/api") -- passed to workspace setup for scoped build */
  scope?: string;
}

/**
 * Derive a clean spec name from a spec file path.
 * Strips .md extension, takes basename, replaces non-alphanumeric with hyphens,
 * collapses consecutive hyphens, and trims leading/trailing hyphens.
 */
export function deriveSpecName(specPath: string): string {
  const basename = path.basename(specPath, '.md');
  return basename
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Create a git worktree as a sibling directory to the project root.
 *
 * Directory naming: {project}-{linear_issue_id}-{spec_name} when Linear issue present,
 *                   {project}-{spec_name} otherwise.
 * Branch naming: forge/{issue-id}/{spec-name} with Linear issue,
 *                forge/{spec-name} without.
 *
 * Falls back to legacy /tmp/ path and plain branch name when no registry options
 * are provided (backward compatibility for pipeline and explicit --branch usage).
 *
 * Every created worktree is registered in the `worktrees` DB table.
 */
export async function createWorktree(
  repoDir: string,
  branch: string,
  registryOptions?: WorktreeRegistryOptions,
): Promise<string> {
  await assertGitRepo(repoDir);

  // ── Auto-prune merged worktrees at 80% disk threshold ──
  if (!registryOptions?.force && !registryOptions?.noAutoPrune) {
    await autoPruneMergedWorktrees(repoDir, registryOptions?.quiet);
  }

  // ── Worktree limit enforcement ─────────────────────────
  if (!registryOptions?.force) {
    const limitCheck = await checkWorktreeLimits(repoDir);
    if (!limitCheck.ok) {
      throw new Error(limitCheck.error!);
    }
  }

  // Determine if we're using sibling directory mode (spec-driven) or legacy mode
  const specPath = registryOptions?.spec_path;
  const linearIssueId = registryOptions?.linear_issue_id;
  const workGroupId = registryOptions?.work_group_id;
  const useSiblingMode = !!specPath;

  let worktreePath: string;
  let effectiveBranch: string;

  if (useSiblingMode) {
    // ── Sibling directory mode ──────────────────────────────
    const specName = deriveSpecName(specPath!);
    const repoRoot = (await execAsync('git rev-parse --show-toplevel', { cwd: repoDir })).stdout.trim();
    const projectName = path.basename(repoRoot);
    const parentDir = path.dirname(repoRoot);

    // Build directory name: {project}-{issue}-{spec} or {project}-{spec}
    const dirParts = [projectName];
    if (linearIssueId) dirParts.push(linearIssueId);
    dirParts.push(specName);
    const baseDirName = dirParts.join('-');

    // Build branch name: forge/{issue}/{spec} or forge/{spec}
    const branchParts = ['forge'];
    if (linearIssueId) branchParts.push(linearIssueId);
    branchParts.push(specName);
    const baseBranch = branchParts.join('/');

    // ── Branch collision handling ───────────────────────────
    // Check if branch already exists AND is checked out in another worktree.
    // If it exists but is not checked out, we can reuse it.
    // If it's already checked out elsewhere, suffix with work_group_id short hash.
    effectiveBranch = baseBranch;
    const branchCollision = await isBranchCheckedOutElsewhere(repoDir, baseBranch);
    if (branchCollision) {
      const suffix = workGroupId ? workGroupId.slice(-4) : Math.random().toString(16).substring(2, 6);
      effectiveBranch = `${baseBranch}-${suffix}`;
    }

    // ── Directory collision handling ────────────────────────
    worktreePath = path.join(parentDir, baseDirName);
    let dirSuffix = 2;
    while (await pathExists(worktreePath)) {
      worktreePath = path.join(parentDir, `${baseDirName}-${dirSuffix}`);
      dirSuffix++;
    }
  } else {
    // ── Legacy mode (backward compat for --branch and pipelines) ──
    const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '-');
    worktreePath = path.join(os.tmpdir(), `forge-worktree-${safeBranch}`);
    effectiveBranch = branch;
  }

  // ── Create the worktree ─────────────────────────────────
  const startPoint = registryOptions?.startPoint || 'HEAD';
  let branchExists = false;
  try {
    await execAsync(`git rev-parse --verify refs/heads/${effectiveBranch}`, { cwd: repoDir });
    branchExists = true;
  } catch {
    // Branch doesn't exist — will create from startPoint
  }

  try {
    if (branchExists) {
      await execAsync(`git worktree add "${worktreePath}" "${effectiveBranch}"`, { cwd: repoDir });
    } else {
      await execAsync(`git worktree add -b "${effectiveBranch}" "${worktreePath}" "${startPoint}"`, { cwd: repoDir });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already checked out') || msg.includes('is already linked')) {
      throw new Error(
        `Branch '${effectiveBranch}' is already checked out in another worktree. ` +
        `Finish or remove that worktree first, or choose a different branch name.`
      );
    }
    if (msg.includes('already exists')) {
      throw new Error(
        `Worktree path already exists: ${worktreePath}. ` +
        `Remove it with: git worktree remove "${worktreePath}" --force`
      );
    }
    throw new Error(`Failed to create worktree: ${msg}`);
  }

  // ── Register in DB ──────────────────────────────────────
  const db = getDb(repoDir);
  if (db && specPath) {
    const id = `wt-${Date.now()}-${Math.random().toString(16).substring(2, 6)}`;
    insertWorktree(db, {
      id,
      work_group_id: workGroupId ?? null,
      spec_path: specPath,
      branch: effectiveBranch,
      worktree_path: worktreePath,
      status: 'created',
      linear_issue_id: linearIssueId ?? null,
    });
  }

  // ── Run workspace setup hooks ────────────────────────────
  // Spec-driven sibling worktrees should bootstrap automatically so a
  // fresh checkout can verify without relying on pre-existing node_modules.
  if (registryOptions?.runSetup || useSiblingMode) {
    const result = await setupWorktree(worktreePath, repoDir, { quiet: registryOptions.quiet, scope: registryOptions.scope });

    if (result && !result.success) {
      // Mark worktree as failed in DB
      const setupDb = getDb(repoDir);
      if (setupDb) {
        const wtRow = getWorktreeByPath(setupDb, worktreePath);
        if (wtRow) {
          const errorMsg = `Workspace setup failed: ${result.failedCommand}`;
          updateWorktreeStatus(setupDb, wtRow.id, 'failed', errorMsg);
        }
      }
    }
  }

  return worktreePath;
}

/** Check if a branch exists and is already checked out in a worktree. */
async function isBranchCheckedOutElsewhere(repoDir: string, branch: string): Promise<boolean> {
  try {
    await execAsync(`git rev-parse --verify refs/heads/${branch}`, { cwd: repoDir });
  } catch {
    return false; // Branch doesn't exist at all — no collision
  }

  // Branch exists — check if it's checked out in a worktree
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', { cwd: repoDir });
    // Parse porcelain output: look for "branch refs/heads/<branch>" lines
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.trim() === `branch refs/heads/${branch}`) {
        return true;
      }
    }
  } catch {
    // If we can't list worktrees, assume no collision
  }
  return false;
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
 * Stage all changes and commit in the worktree.
 * Returns true if a commit was made, false if there was nothing to commit.
 */
export async function commitWorktree(worktreePath: string, branch: string): Promise<boolean> {
  // Check if there are any changes to commit
  const { stdout: status } = await execAsync('git status --porcelain', { cwd: worktreePath });
  if (!status.trim()) {
    return false;
  }

  await execAsync('git add -A -- . ":!.forge"', { cwd: worktreePath });
  const message = `forge: branch isolation results on ${branch}`;
  await execAsync(`git commit -m "${message}"`, { cwd: worktreePath });
  return true;
}

/**
 * Consolidate completed worktree branches into a single merge branch.
 * Creates a temporary worktree, merges each branch sequentially, then cleans up.
 * Returns the consolidation branch name for use as the startPoint of the next level.
 *
 * @param repoDir - The original repo directory
 * @param branches - Branch names to merge (from successful worktrees in the level)
 * @param levelIndex - Level number (for naming the consolidation branch)
 * @param workGroupId - Work group ID for scoping the consolidation branch
 * @param baseBranch - The branch to start from (default: HEAD). For level > 0, this is the previous consolidation branch.
 * @returns The consolidation branch name
 */
export async function consolidateLevelBranches(
  repoDir: string,
  branches: string[],
  levelIndex: number,
  workGroupId: string,
  baseBranch?: string,
): Promise<string> {
  if (branches.length === 0) {
    throw new Error('No branches to consolidate');
  }

  const consolidationBranch = `forge/consolidate-${workGroupId.slice(-8)}-level-${levelIndex}`;
  const startRef = baseBranch || 'HEAD';

  // Create the consolidation branch from the base
  try {
    await execAsync(`git branch -D "${consolidationBranch}"`, { cwd: repoDir });
  } catch {
    // Branch didn't exist — fine
  }
  await execAsync(`git branch "${consolidationBranch}" "${startRef}"`, { cwd: repoDir });

  // Create a temporary worktree to perform the merges
  const tmpPath = path.join(os.tmpdir(), `forge-consolidate-${workGroupId.slice(-8)}-${levelIndex}-${Date.now()}`);
  try {
    await execAsync(`git worktree add "${tmpPath}" "${consolidationBranch}"`, { cwd: repoDir });

    // Merge each branch
    for (const branch of branches) {
      await execAsync(`git merge "${branch}" --no-edit -m "forge: consolidate ${branch} into level ${levelIndex}"`, { cwd: tmpPath });
    }
  } finally {
    // Clean up the temporary worktree
    try {
      await execAsync(`git worktree remove "${tmpPath}" --force`, { cwd: repoDir });
    } catch {
      try {
        await fs.rm(tmpPath, { recursive: true, force: true });
        await execAsync('git worktree prune', { cwd: repoDir });
      } catch {
        // Best effort cleanup
      }
    }
  }

  return consolidationBranch;
}

/** Options for worktree cleanup. */
export interface CleanupWorktreeOptions {
  /** Run workspace teardown hooks before removing the worktree */
  runTeardown?: boolean;
  /** Suppress console output from teardown hooks */
  quiet?: boolean;
}

/**
 * Remove the worktree and clean up git's worktree tracking.
 * When `runTeardown` is true, runs teardown hooks before removal (best-effort).
 */
export async function cleanupWorktree(
  worktreePath: string,
  repoDir: string,
  options?: CleanupWorktreeOptions,
): Promise<void> {
  // Run teardown hooks before removal (best-effort)
  if (options?.runTeardown) {
    try {
      await teardownWorktree(worktreePath, repoDir, { quiet: options.quiet });
    } catch {
      // Best effort -- don't fail cleanup on teardown error
    }
  }

  try {
    await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: repoDir });
  } catch {
    // If git worktree remove fails, try manual cleanup
    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
      await execAsync('git worktree prune', { cwd: repoDir });
    } catch {
      // Best effort — don't throw during cleanup
    }
  }
}

export async function saveResult(
  workingDir: string,
  result: ForgeResult,
  _resultText: string
): Promise<string> {
  // Create timestamp-based ID (filesystem safe)
  const timestamp = result.startedAt.replace(/[:.]/g, '-');

  await ensureForgeDir(workingDir);

  // Insert into SQLite database (sole store for run metadata)
  const db = getDb(workingDir);
  if (db) {
    insertRun(db, {
      id: timestamp,
      specPath: result.specPath || null,
      model: result.model || 'unknown',
      status: result.status,
      costUsd: result.costUsd ?? null,
      durationSeconds: result.durationSeconds,
      numTurns: result.numTurns ?? null,
      toolCalls: result.toolCalls ?? null,
      batchId: result.runId || null,
      type: result.type || null,
      prompt: result.prompt,
      cwd: result.cwd,
      sessionId: result.sessionId || null,
      error: result.error || null,
      createdAt: result.startedAt,
    });
  }

  return timestamp;
}
