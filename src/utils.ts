import type { ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

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

// ── Git Worktree Helpers ─────────────────────────────────────

/** Validate that a directory is inside a git repository. */
async function assertGitRepo(dir: string): Promise<void> {
  try {
    await execAsync('git rev-parse --git-dir', { cwd: dir });
  } catch {
    throw new Error(`--branch requires a git repository (not found in ${dir})`);
  }
}

/**
 * Create a git worktree for the given branch.
 * If the branch exists, checks it out; if not, creates from HEAD.
 * Returns the absolute path to the worktree directory.
 */
export async function createWorktree(repoDir: string, branch: string): Promise<string> {
  await assertGitRepo(repoDir);

  // Deterministic path: /tmp/forge-worktree-<branch>
  const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '-');
  const worktreePath = path.join(os.tmpdir(), `forge-worktree-${safeBranch}`);

  // Check if branch already exists
  let branchExists = false;
  try {
    await execAsync(`git rev-parse --verify refs/heads/${branch}`, { cwd: repoDir });
    branchExists = true;
  } catch {
    // Branch doesn't exist — will create from HEAD
  }

  try {
    if (branchExists) {
      await execAsync(`git worktree add "${worktreePath}" "${branch}"`, { cwd: repoDir });
    } else {
      await execAsync(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, { cwd: repoDir });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already checked out') || msg.includes('is already linked')) {
      throw new Error(
        `Branch '${branch}' is already checked out in another worktree. ` +
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

  return worktreePath;
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
 * Remove the worktree and clean up git's worktree tracking.
 */
export async function cleanupWorktree(worktreePath: string, repoDir: string): Promise<void> {
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
  resultText: string
): Promise<string> {
  // Create timestamp-based directory name (filesystem safe)
  const timestamp = result.startedAt.replace(/[:.]/g, '-');
  const resultsDir = path.join(workingDir, '.forge', 'results', timestamp);

  await fs.mkdir(resultsDir, { recursive: true });

  // Save structured summary
  const summaryPath = path.join(resultsDir, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(result, null, 2));

  // Save full result text (no truncation)
  const resultPath = path.join(resultsDir, 'result.md');
  const resultContent = `# Forge Result

**Started**: ${result.startedAt}
**Completed**: ${result.completedAt}
**Duration**: ${result.durationSeconds.toFixed(1)}s
**Status**: ${result.status}
**Cost**: ${result.costUsd !== undefined ? `$${result.costUsd.toFixed(4)}` : 'N/A'}
**Model**: ${result.model}
${result.sessionId ? `**Session**: ${result.sessionId}` : ''}
${result.specPath ? `**Spec**: ${result.specPath}` : ''}

## Prompt

${result.prompt}

## Result

${resultText}
`;
  await fs.writeFile(resultPath, resultContent);

  return resultsDir;
}
