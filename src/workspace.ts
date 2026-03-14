// ── Workspace Setup and Teardown Hooks ───────────────────────
//
// Auto-detects project type and runs setup commands after worktree
// creation, teardown commands before worktree removal. Config
// overrides via .forge/config.json take precedence over auto-detection.

import { promises as fs } from 'fs';
import path from 'path';
import { execAsync, detectPackageManager } from './utils.js';
import type { ForgeLocalConfig } from './config.js';

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
