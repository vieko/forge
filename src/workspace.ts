// ── Workspace Setup and Teardown Hooks ───────────────────────
//
// Auto-detects project type and runs setup commands after worktree
// creation, teardown commands before worktree removal. Config
// overrides via .forge/config.json take precedence over auto-detection.

import { promises as fs } from 'fs';
import path from 'path';
import { execAsync, detectPackageManager } from './utils.js';
import { getConfig } from './config.js';
import type { ForgeLocalConfig } from './config.js';

// ── Shared Files ────────────────────────────────────────────

const GLOB_CHARS = /[*?{}\[\]]/;

/**
 * Resolve sharedFiles entries into concrete relative paths.
 * Entries without glob characters are returned as-is.
 * Glob patterns are expanded against the source directory using Bun.Glob.
 */
export async function resolveSharedFiles(
  configDir: string,
  patterns: string[],
): Promise<string[]> {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    if (!GLOB_CHARS.test(pattern)) {
      if (!seen.has(pattern)) {
        seen.add(pattern);
        resolved.push(pattern);
      }
      continue;
    }

    const glob = new Bun.Glob(pattern);
    for await (const match of glob.scan({ cwd: configDir, absolute: false, dot: true })) {
      if (!seen.has(match)) {
        seen.add(match);
        resolved.push(match);
      }
    }
  }

  return resolved;
}

/**
 * Symlink shared files (e.g. .env, .env.local) from the source repo
 * into a worktree. Falls back to copy if symlink fails (e.g. Windows
 * without developer mode). Skips files that don't exist in the source.
 *
 * Supports glob patterns in the file list (e.g. "**\/.env.local").
 * Creates parent directories in the worktree as needed (supports
 * nested paths like "config/.env").
 */
export async function linkSharedFiles(
  worktreePath: string,
  configDir: string,
  files: string[],
  quiet?: boolean,
): Promise<{ linked: string[]; skipped: string[]; failed: string[] }> {
  // Expand any glob patterns to concrete paths
  const resolvedFiles = await resolveSharedFiles(configDir, files);

  const linked: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const file of resolvedFiles) {
    const sourcePath = path.resolve(configDir, file);
    const targetPath = path.resolve(worktreePath, file);

    // Check source exists
    try {
      await fs.access(sourcePath);
    } catch {
      skipped.push(file);
      continue;
    }

    // Ensure parent directory exists in worktree
    const targetDir = path.dirname(targetPath);
    await fs.mkdir(targetDir, { recursive: true });

    // Remove existing target (stale symlink, previous copy, etc.)
    try {
      await fs.unlink(targetPath);
    } catch {
      // Doesn't exist -- fine
    }

    // Symlink, fall back to copy
    try {
      await fs.symlink(sourcePath, targetPath);
      linked.push(file);
    } catch {
      try {
        await fs.copyFile(sourcePath, targetPath);
        linked.push(file);
      } catch (err) {
        failed.push(file);
        if (!quiet) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`\x1b[2m[forge]\x1b[0m Failed to link ${file}: ${msg}`);
        }
      }
    }
  }

  return { linked, skipped, failed };
}

// ── Types ────────────────────────────────────────────────────

export interface WorkspaceHookResult {
  /** Whether all commands succeeded */
  success: boolean;
  /** Combined stdout/stderr from all commands */
  output: string;
  /** Description of the failed command (if any) */
  failedCommand?: string;
}

// ── Auto-Detection ───────────────────────────────────────────

/**
 * Auto-detect setup commands based on project files present in the
 * working directory. Multiple project types can coexist (e.g. a
 * monorepo with both package.json and Cargo.toml).
 *
 * Detection rules (Node.js uses lockfile-based package manager detection):
 *   bun.lockb / bun.lock    ->  bun install
 *   pnpm-lock.yaml          ->  pnpm install
 *   yarn.lock               ->  yarn install
 *   package-lock.json        ->  npm install
 *   package.json (no lock)  ->  npm install
 *   Cargo.toml              ->  cargo build
 *   go.mod                  ->  go mod download
 */
export async function detectSetupCommands(workingDir: string): Promise<string[]> {
  const commands: string[] = [];

  // Node.js: detect package manager from lockfiles
  const pm = await detectPackageManager(workingDir);
  if (pm) {
    commands.push(`${pm} install`);
  }

  // Rust
  try {
    await fs.access(path.join(workingDir, 'Cargo.toml'));
    commands.push('cargo build');
  } catch {
    // Not present -- skip
  }

  // Go
  try {
    await fs.access(path.join(workingDir, 'go.mod'));
    commands.push('go mod download');
  } catch {
    // Not present -- skip
  }

  return commands;
}

// ── Command Resolution ───────────────────────────────────────

/**
 * Resolve setup commands: config overrides take precedence over
 * auto-detection. If config.setup is non-empty, those commands
 * are used verbatim; otherwise auto-detection runs.
 */
export async function resolveSetupCommands(
  workingDir: string,
  config: ForgeLocalConfig,
): Promise<string[]> {
  if (config.setup.length > 0) {
    return config.setup;
  }
  return detectSetupCommands(workingDir);
}

/**
 * Resolve teardown commands from config. Teardown has no
 * auto-detection -- only explicit config commands run.
 */
export function resolveTeardownCommands(config: ForgeLocalConfig): string[] {
  return config.teardown;
}

// ── Hook Execution ───────────────────────────────────────────

/**
 * Run workspace hook commands sequentially in the given directory.
 * Stops on first failure. Each command runs with the configured
 * timeout. Returns combined output for logging.
 */
export async function runWorkspaceHooks(
  commands: string[],
  workingDir: string,
  timeoutMs: number,
  quiet?: boolean,
): Promise<WorkspaceHookResult> {
  if (commands.length === 0) {
    return { success: true, output: '' };
  }

  const outputLines: string[] = [];

  for (const cmd of commands) {
    if (!quiet) {
      console.log(`\x1b[2m[forge]\x1b[0m Running: ${cmd}`);
    }

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: workingDir,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for install output
      });
      if (stdout) outputLines.push(stdout);
      if (stderr) outputLines.push(stderr);
    } catch (err) {
      const error = err as {
        stderr?: string;
        stdout?: string;
        message?: string;
        killed?: boolean;
      };
      const errorOutput =
        error.stderr || error.stdout || error.message || 'Unknown error';
      outputLines.push(errorOutput);

      // Detect timeout (child_process sets killed=true on timeout)
      const isTimeout = error.killed === true;
      const failureReason = isTimeout
        ? `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${cmd}`
        : `Command failed: ${cmd}`;

      return {
        success: false,
        output: outputLines.join('\n'),
        failedCommand: failureReason,
      };
    }
  }

  return {
    success: true,
    output: outputLines.join('\n'),
  };
}

// ── High-Level Workspace Lifecycle ──────────────────────────

/** Options for high-level setup/teardown operations. */
export interface WorkspaceLifecycleOptions {
  /** Suppress console output */
  quiet?: boolean;
  /** Monorepo package scope (e.g. "packages/api") -- triggers scoped setup after root install */
  scope?: string;
}

/**
 * Detect package-level build/setup commands for a scoped package directory.
 * Returns commands that should run from the package directory after root-level install.
 *
 * For Node.js packages: checks for build scripts in the package's package.json.
 * Root-level install (bun/pnpm/yarn/npm install) handles dependency installation
 * for all packages via hoisted lockfiles -- no per-package install needed.
 */
export async function detectScopedSetupCommands(
  worktreePath: string,
  scope: string,
): Promise<{ commands: string[]; cwd: string }> {
  const scopedDir = path.join(worktreePath, scope);
  const commands: string[] = [];

  // Node.js: check for package.json with build script in scoped dir
  try {
    const pkgJsonPath = path.join(scopedDir, 'package.json');
    const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
    const scripts = pkgJson.scripts || {};

    // Use root-level PM for running scoped scripts
    const pm = await detectPackageManager(worktreePath);
    const runner = pm || 'npm';

    if (scripts.build) {
      commands.push(`${runner} run build`);
    }
  } catch {
    // No package.json or unreadable -- skip
  }

  // Rust: check for Cargo.toml in scoped dir
  try {
    await fs.access(path.join(scopedDir, 'Cargo.toml'));
    commands.push('cargo build');
  } catch {
    // Not present -- skip
  }

  // Go: check for go.mod in scoped dir
  try {
    await fs.access(path.join(scopedDir, 'go.mod'));
    commands.push('go mod download');
  } catch {
    // Not present -- skip
  }

  return { commands, cwd: scopedDir };
}

/**
 * Run workspace setup in a worktree directory.
 *
 * Resolves config from `configDir` (typically the original repo root),
 * detects project type, and runs setup commands in `worktreePath`.
 * Config overrides via .forge/config.json take precedence over auto-detection.
 *
 * When a scope is specified (monorepo package targeting), setup runs in two phases:
 *   1. Root-level install (lockfile-aware, installs all packages via hoisted lockfiles)
 *   2. Package-level build/setup from the scoped directory
 *
 * Returns null if no setup commands were detected; otherwise returns the hook result.
 */
export async function setupWorktree(
  worktreePath: string,
  configDir: string,
  options?: WorkspaceLifecycleOptions,
): Promise<WorkspaceHookResult | null> {
  const config = getConfig(configDir);
  const commands = await resolveSetupCommands(worktreePath, config);
  const hasSharedFiles = config.sharedFiles.length > 0;

  if (commands.length === 0 && !options?.scope && !hasSharedFiles) {
    return null;
  }

  // Phase 0: Symlink shared files (before install -- some postinstall scripts read .env)
  if (hasSharedFiles) {
    const { linked, skipped, failed } = await linkSharedFiles(
      worktreePath,
      configDir,
      config.sharedFiles,
      options?.quiet,
    );
    if (!options?.quiet && linked.length > 0) {
      console.log(`\x1b[2m[forge]\x1b[0m Linked shared files: ${linked.join(', ')}`);
    }
    if (!options?.quiet && skipped.length > 0) {
      console.log(`\x1b[2m[forge]\x1b[0m Skipped (not found in source): ${skipped.join(', ')}`);
    }
  }

  if (!options?.quiet && commands.length > 0) {
    const scopeNote = options?.scope ? ` (root + scoped: ${options.scope})` : '';
    console.log(`\x1b[2m[forge]\x1b[0m Running workspace setup (${commands.length} command${commands.length > 1 ? 's' : ''})${scopeNote}...`);
  }

  // Phase 1: Root-level setup (install, etc.)
  let result: WorkspaceHookResult = { success: true, output: '' };
  if (commands.length > 0) {
    result = await runWorkspaceHooks(commands, worktreePath, config.setupTimeout, options?.quiet);
    if (!result.success) {
      return result;
    }
  }

  // Phase 2: Scoped package-level setup (build, etc.)
  if (options?.scope && result.success) {
    const scoped = await detectScopedSetupCommands(worktreePath, options.scope);
    if (scoped.commands.length > 0) {
      if (!options?.quiet) {
        console.log(`\x1b[2m[forge]\x1b[0m Running scoped setup in ${options.scope} (${scoped.commands.length} command${scoped.commands.length > 1 ? 's' : ''})...`);
      }
      const scopedResult = await runWorkspaceHooks(scoped.commands, scoped.cwd, config.setupTimeout, options?.quiet);
      if (!scopedResult.success) {
        return {
          success: false,
          output: result.output + '\n' + scopedResult.output,
          failedCommand: scopedResult.failedCommand,
        };
      }
      result = {
        success: true,
        output: result.output + '\n' + scopedResult.output,
      };
    }
  }

  if (result.success && !options?.quiet) {
    console.log(`\x1b[2m[forge]\x1b[0m Workspace setup complete`);
  }

  return result.output ? result : null;
}

/**
 * Run workspace teardown in a worktree directory.
 *
 * Resolves config from `configDir` (typically the original repo root),
 * runs teardown commands in `worktreePath`. Teardown is best-effort --
 * failures are reported but do not throw.
 *
 * Returns null if no teardown commands are configured; otherwise returns the hook result.
 */
export async function teardownWorktree(
  worktreePath: string,
  configDir: string,
  options?: WorkspaceLifecycleOptions,
): Promise<WorkspaceHookResult | null> {
  const config = getConfig(configDir);
  const commands = resolveTeardownCommands(config);

  if (commands.length === 0) {
    return null;
  }

  if (!options?.quiet) {
    console.log(`\x1b[2m[forge]\x1b[0m Running workspace teardown (${commands.length} command${commands.length > 1 ? 's' : ''})...`);
  }

  const result = await runWorkspaceHooks(commands, worktreePath, config.setupTimeout, options?.quiet);

  if (!result.success && !options?.quiet) {
    console.log(`\x1b[2m[forge]\x1b[0m Teardown warning: ${result.failedCommand}`);
  }

  return result;
}
