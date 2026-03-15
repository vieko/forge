/**
 * Forge Task Executor Daemon
 *
 * Long-running process that polls the tasks table for pending work
 * and executes via direct function import (no CLI spawn, no child
 * process management). The database is the coordination layer between
 * MCP (which inserts pending tasks) and execution (this daemon).
 *
 * Start with: forge executor [-C <cwd>] [--concurrency <n>]
 */

import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { getForgeEntryPoint } from './utils.js';
import {
  getDb,
  getTaskById,
  updateTaskStatus,
  updateTaskOutput,
  updateTaskSessionId,
  markStaleTasks,
  getPendingTasks,
  claimTask,
} from './db.js';
import type { TaskRow } from './db.js';
import { runSingleSpec } from './run.js';
import { runAudit } from './audit.js';
import { runDefine } from './define.js';
import { runProof } from './proof.js';
import { runVerify as runVerifyFn } from './proof-runner.js';
import { runForge } from './parallel.js';
import { runPipeline } from './pipeline.js';
import { SqliteStateProvider, markStalePipelines } from './db-pipeline-state.js';
import { isInterrupted, triggerAbort } from './abort.js';
import { DIM, RESET, BOLD } from './display.js';
import { getConfig } from './config.js';
import type { GateKey, GateType, StageName } from './pipeline-types.js';
import { ExecutorTaskContext } from './task-context.js';

// ── Constants ────────────────────────────────────────────────

const POLL_INTERVAL_MS = 1000;
const DEFAULT_CONCURRENCY = 2;
const MAX_BUFFER_LINES = 50;
const STALE_TASK_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Types ────────────────────────────────────────────────────

export interface ExecutorOptions {
  cwd?: string;
  concurrency?: number;
  quiet?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────

function pushLine(buf: string[], line: string): void {
  buf.push(line);
  if (buf.length > MAX_BUFFER_LINES) {
    buf.splice(0, buf.length - MAX_BUFFER_LINES);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an executor is already running by reading the PID file
 * and verifying process liveness. Used by both the executor (to
 * prevent duplicates) and MCP (to verify executor availability).
 */
export async function isExecutorRunning(cwd: string): Promise<boolean> {
  const pidPath = path.join(cwd, '.forge', 'executor.pid');
  try {
    const pidStr = await fs.readFile(pidPath, 'utf-8');
    const pid = parseInt(pidStr.trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // Signal 0: check liveness without killing
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a detached executor process that survives the parent exiting.
 * Runs with --quiet since there's no terminal to print to.
 * Returns true if the spawn succeeded (does not wait for startup).
 */
export function spawnDetachedExecutor(cwd: string): boolean {
  try {
    const resolvedCwd = path.resolve(cwd);
    // Use process.argv[0] (bun/node) to run the forge CLI entry point.
    const forgeBin = getForgeEntryPoint();
    const child = spawn(process.argv[0], [forgeBin, 'executor', '--quiet', '-C', resolvedCwd], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure an executor is running for the given working directory.
 * If none is running, spawn a detached one and wait briefly for the PID file.
 * Returns { running: true, spawned: false } if already running,
 * { running: true, spawned: true } if we just spawned one,
 * { running: false, spawned: false } if spawn failed.
 */
export async function ensureExecutorRunning(cwd: string): Promise<{ running: boolean; spawned: boolean }> {
  const resolvedCwd = path.resolve(cwd);

  // Already running — nothing to do
  if (await isExecutorRunning(resolvedCwd)) {
    return { running: true, spawned: false };
  }

  // Spawn a detached executor
  if (!spawnDetachedExecutor(resolvedCwd)) {
    return { running: false, spawned: false };
  }

  // Wait briefly for the PID file to appear (handles race between spawn and PID write).
  // Check every 100ms for up to 2 seconds.
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (await isExecutorRunning(resolvedCwd)) {
      return { running: true, spawned: true };
    }
  }

  // One final check — the executor may have started but PID check is flaky
  return { running: await isExecutorRunning(resolvedCwd), spawned: true };
}

/** Get session directory contents for snapshot-based session ID capture. */
async function getSessionDirs(cwd: string): Promise<Set<string>> {
  const sessionsDir = path.join(cwd, '.forge', 'sessions');
  try {
    const dirs = await fs.readdir(sessionsDir);
    return new Set(dirs);
  } catch {
    return new Set();
  }
}

// ── Queued Option Contract ────────────────────────────────────
//
// Options supported by dispatchTask() for queued tasks (via MCP forge_start).
// These are extracted from typed task `params` JSON and/or `extraArgs` string array.
//
// SUPPORTED (typed params — preferred for commonly used options):
//   model         - Model shorthand or full ID (all commands)
//   specPath      - Spec file or directory path (run, audit, proof, verify)
//   outputDir     - Output directory (define, audit, proof, verify)
//   maxTurns      - Maximum agent turns (all commands)
//   maxBudgetUsd  - Maximum budget in USD (all commands)
//   planOnly      - Plan-only mode, no implementation (run)
//   planModel     - Model for plan-only runs (run)
//   dryRun        - Preview without executing (run, verify)
//
// SUPPORTED (extraArgs — for less common or flag-style options):
//   --force / -F         - Force re-run of passed specs (run)
//   --sequential         - Run specs sequentially (run)
//   --sequential-first N - Run first N specs sequentially (run)
//   --concurrency N      - Max concurrent specs (run)
//   --rerun-failed       - Rerun only failed specs (run)
//   --pending            - Run only pending specs (run)
//   --branch <name>      - Run in isolated git worktree (run)
//   --fix                - Audit-fix convergence loop (audit)
//   --fix-rounds N       - Max audit-fix rounds (audit)
//
// INTENTIONALLY EXCLUDED:
//   verbose       - Executor is always quiet; no terminal to print to
//   resume/fork   - Session management doesn't apply to queued tasks;
//                   each task gets a fresh session
//   _onSpecResult - Internal callback; executor handles its own per-spec logging
//   _silent       - Internal display flag; executor controls its own output
//   persistDir    - Set by pipeline orchestrator, not by individual tasks

// ── Helpers: extraArgs parsing ───────────────────────────────

/** Extract a string value following a flag in extraArgs, e.g. --branch <name> */
function extractStringArg(extraArgs: string[], flag: string): string | undefined {
  const idx = extraArgs.indexOf(flag);
  if (idx >= 0 && idx + 1 < extraArgs.length) return extraArgs[idx + 1];
  return undefined;
}

/** Extract a numeric value following a flag in extraArgs, e.g. --concurrency 5 */
function extractNumberArg(extraArgs: string[], flag: string): number | undefined {
  const val = extractStringArg(extraArgs, flag);
  if (val !== undefined) {
    const n = parseInt(val, 10);
    if (!isNaN(n)) return n;
  }
  return undefined;
}

/** Check if a flag is present in extraArgs, e.g. --sequential */
function hasFlag(extraArgs: string[], ...flags: string[]): boolean {
  return flags.some(f => extraArgs.includes(f));
}

// ── Task dispatch ────────────────────────────────────────────

/**
 * Dispatch a task to the appropriate forge function based on the
 * command name and stored parameters. All functions are called with
 * quiet: true to prevent console noise in the shared executor process.
 */
async function dispatchTask(task: TaskRow, workingDir: string, quiet?: boolean): Promise<void> {
  const params: Record<string, unknown> = JSON.parse(task.params || '{}');
  const cmd = task.command.replace(/^forge\s+/, '');
  const extraArgs = (params.extraArgs || []) as string[];
  const taskShortId = task.id.slice(0, 8);

  // Extract typed params (preferred over extraArgs for common options)
  const model = params.model as string | undefined;
  const maxTurns = params.maxTurns as number | undefined;
  const maxBudgetUsd = params.maxBudgetUsd as number | undefined;
  const planOnly = params.planOnly as boolean | undefined;
  const planModel = params.planModel as string | undefined;
  const dryRun = params.dryRun as boolean | undefined;

  switch (cmd) {
    case 'run': {
      const specPath = (params.specPath || task.specPath) as string | undefined;

      // Extract run-specific options from extraArgs
      const sequential = hasFlag(extraArgs, '--sequential');
      const force = hasFlag(extraArgs, '--force', '-F');
      const rerunFailed = hasFlag(extraArgs, '--rerun-failed');
      const pendingOnly = hasFlag(extraArgs, '--pending');
      const sequentialFirst = extractNumberArg(extraArgs, '--sequential-first');
      const concurrency = extractNumberArg(extraArgs, '--concurrency');
      const branch = extractStringArg(extraArgs, '--branch');

      if (specPath) {
        const resolvedSpec = path.resolve(workingDir, specPath);
        let isDir = false;
        try {
          const stat = await fs.stat(resolvedSpec);
          isDir = stat.isDirectory();
        } catch {
          // Path doesn't exist yet — treat as file, let forge handle the error
        }

        if (isDir) {
          // Count specs for the log line
          let specCount = 0;
          try {
            const entries = await fs.readdir(resolvedSpec);
            specCount = entries.filter(e => e.endsWith('.md')).length;
          } catch { /* best effort */ }

          if (!quiet && specCount > 1) {
            console.log(`${DIM}[executor]${RESET} > ${task.command} (${taskShortId}) ${specCount} specs [${sequential ? 'sequential' : 'parallel'}]`);
          }

          await runForge({
            prompt: task.description || 'implement',
            specDir: specPath,
            cwd: workingDir,
            model,
            maxTurns,
            maxBudgetUsd,
            planOnly: planOnly ?? hasFlag(extraArgs, '--plan-only'),
            planModel: planModel ?? extractStringArg(extraArgs, '--plan-model'),
            dryRun: dryRun ?? hasFlag(extraArgs, '--dry-run'),
            quiet: true,
            sequential,
            sequentialFirst,
            concurrency,
            rerunFailed,
            pendingOnly,
            force,
            branch,
            _batchTaskContext: new ExecutorTaskContext(task.id),
            _onSpecResult: quiet ? undefined : (spec, status) => {
              const icon = status === 'success' ? '+' : 'x';
              console.log(`${DIM}[executor]${RESET}   ${icon} ${spec} (${taskShortId})`);
            },
          });
        } else {
          await runSingleSpec({
            prompt: task.description || 'implement',
            specPath,
            cwd: workingDir,
            model,
            maxTurns,
            maxBudgetUsd,
            planOnly: planOnly ?? hasFlag(extraArgs, '--plan-only'),
            planModel: planModel ?? extractStringArg(extraArgs, '--plan-model'),
            dryRun: dryRun ?? hasFlag(extraArgs, '--dry-run'),
            quiet: true,
            _silent: true,
            taskContext: new ExecutorTaskContext(task.id),
          });
        }
      } else {
        await runSingleSpec({
          prompt: task.description || '',
          cwd: workingDir,
          model,
          maxTurns,
          maxBudgetUsd,
          planOnly: planOnly ?? hasFlag(extraArgs, '--plan-only'),
          planModel: planModel ?? extractStringArg(extraArgs, '--plan-model'),
          dryRun: dryRun ?? hasFlag(extraArgs, '--dry-run'),
          quiet: true,
          _silent: true,
          taskContext: new ExecutorTaskContext(task.id),
        });
      }
      break;
    }

    case 'audit': {
      const specPath = (params.specPath || task.specPath) as string;
      await runAudit({
        specDir: specPath,
        prompt: task.description || undefined,
        outputDir: params.outputDir as string | undefined,
        cwd: workingDir,
        model,
        maxTurns,
        maxBudgetUsd,
        quiet: true,
        fix: hasFlag(extraArgs, '--fix'),
        fixRounds: extractNumberArg(extraArgs, '--fix-rounds'),
      });
      break;
    }

    case 'define': {
      await runDefine({
        prompt: task.description || '',
        outputDir: params.outputDir as string | undefined,
        cwd: workingDir,
        model,
        maxTurns,
        maxBudgetUsd,
        quiet: true,
      });
      break;
    }

    case 'proof':
    case 'prove': {
      const specPath = (params.specPath || task.specPath) as string;
      const specPaths = specPath ? specPath.split(/\s+/).filter(Boolean) : [];
      await runProof({
        specPaths,
        outputDir: params.outputDir as string | undefined,
        cwd: workingDir,
        model,
        maxTurns,
        maxBudgetUsd,
        quiet: true,
      });
      break;
    }

    case 'verify': {
      const specPath = (params.specPath || task.specPath) as string;
      await runVerifyFn({
        proofDir: specPath,
        outputDir: params.outputDir as string | undefined,
        cwd: workingDir,
        model,
        maxTurns,
        maxBudgetUsd,
        dryRun: dryRun ?? hasFlag(extraArgs, '--dry-run'),
        quiet: true,
      });
      break;
    }

    case 'pipeline': {
      // Build gate overrides from params
      let gates: Partial<Record<GateKey, GateType>> | undefined;
      if (params.gateAll) {
        const type = params.gateAll as GateType;
        gates = {
          'define -> run': type,
          'run -> audit': type,
          'audit -> proof': type,
          'proof -> verify': type,
        };
      }

      const db = getDb(workingDir);
      if (!db) throw new Error('Database unavailable — cannot run pipeline');
      const stateProvider = new SqliteStateProvider(db);
      await runPipeline(
        {
          goal: task.description || '',
          gates,
          fromStage: params.fromStage as StageName | undefined,
          specDir: params.specPath as string | undefined,
          cwd: workingDir,
          model,
          resume: params.resume as string | undefined,
          quiet: true,
        },
        stateProvider,
      );
      break;
    }

    default:
      throw new Error(`Unknown command: ${task.command}`);
  }
}

// ── Task execution ───────────────────────────────────────────

/**
 * Execute a single task: dispatch to the appropriate function,
 * capture session ID via directory snapshot, update DB on completion.
 */
async function executeTask(
  task: TaskRow,
  workingDir: string,
  quiet?: boolean,
): Promise<void> {
  const db = getDb(workingDir);
  if (!db) return;

  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];

  pushLine(stdoutBuf, `Executing ${task.command}...`);
  updateTaskOutput(db, task.id, stdoutBuf, stderrBuf);

  // Snapshot sessions directory before execution for session ID capture
  const beforeSessions = await getSessionDirs(workingDir);

  try {
    await dispatchTask(task, workingDir, quiet);

    // Capture session ID: new session directories created during execution
    const afterSessions = await getSessionDirs(workingDir);
    const newSessions = [...afterSessions].filter(s => !beforeSessions.has(s));
    if (newSessions.length > 0) {
      // Use the latest new session (most recently created)
      const sorted = newSessions.sort();
      updateTaskSessionId(db, task.id, sorted[sorted.length - 1]);
    }

    updateTaskStatus(db, task.id, 'completed', 0);
    pushLine(stdoutBuf, 'Task completed successfully.');
    updateTaskOutput(db, task.id, stdoutBuf, stderrBuf);
  } catch (err) {
    // Capture session ID even on failure
    const afterSessions = await getSessionDirs(workingDir);
    const newSessions = [...afterSessions].filter(s => !beforeSessions.has(s));
    if (newSessions.length > 0) {
      const sorted = newSessions.sort();
      updateTaskSessionId(db, task.id, sorted[sorted.length - 1]);
    }

    const msg = err instanceof Error ? err.message : String(err);
    pushLine(stderrBuf, `Error: ${msg}`);
    updateTaskStatus(db, task.id, 'failed', 1);
    updateTaskOutput(db, task.id, stdoutBuf, stderrBuf);
  }
}

// ── Main daemon loop ─────────────────────────────────────────

/**
 * Start the executor daemon. Polls the tasks table for pending work
 * and executes tasks concurrently up to the configured limit.
 *
 * The executor writes its PID to .forge/executor.pid for liveness
 * checks by MCP and other processes. On shutdown, the PID file is
 * cleaned up and running tasks are allowed to finish (30s timeout).
 */
export async function startExecutor(options: ExecutorOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const quiet = options.quiet ?? false;

  // Ensure .forge directory exists
  const forgeDir = path.join(workingDir, '.forge');
  await fs.mkdir(forgeDir, { recursive: true });

  // Check if another executor is already running for this directory
  if (await isExecutorRunning(workingDir)) {
    console.error('forge: An executor is already running for this directory.');
    process.exit(1);
  }

  // Write PID file
  const pidPath = path.join(forgeDir, 'executor.pid');
  await fs.writeFile(pidPath, String(process.pid));

  // Cleanup PID file on exit
  const cleanup = async () => {
    try {
      await fs.unlink(pidPath);
    } catch {
      // Best effort — PID file may already be removed
    }
  };

  // Graceful shutdown handlers
  process.on('SIGINT', () => {
    if (!isInterrupted()) {
      triggerAbort();
      if (!quiet) console.log('\nExecutor shutting down gracefully...');
    } else {
      // Second Ctrl-C: force exit
      cleanup().finally(() => process.exit(1));
    }
  });

  process.on('SIGTERM', () => {
    triggerAbort();
    if (!quiet) console.log('\nExecutor received SIGTERM, shutting down...');
  });

  // Load idle timeout from config (default: 5 minutes / 300000ms)
  const config = getConfig(workingDir);
  const idleTimeoutMs = config.executorIdleTimeout;

  if (!quiet) {
    console.log(`${BOLD}forge executor${RESET}`);
    console.log(`${DIM}Working directory:${RESET} ${workingDir}`);
    console.log(`${DIM}Concurrency:${RESET}      ${concurrency}`);
    console.log(`${DIM}PID:${RESET}              ${process.pid}`);
    console.log(`${DIM}Polling:${RESET}          ${POLL_INTERVAL_MS}ms`);
    console.log(`${DIM}Idle timeout:${RESET}     ${idleTimeoutMs > 0 ? `${Math.round(idleTimeoutMs / 1000)}s` : 'disabled'}\n`);
    console.log(`${DIM}Waiting for tasks...${RESET}\n`);
  }

  let runningCount = 0;
  const runningTaskIds = new Set<string>();

  // Idle timeout tracking: reset whenever a task is claimed or completed
  let lastActivityAt = Date.now();

  while (!isInterrupted()) {
    const db = getDb(workingDir);
    if (!db) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Mark stale tasks and pipelines (abandoned by dead processes)
    markStaleTasks(db, STALE_TASK_TTL_MS);
    markStalePipelines(db);

    // Pick up pending tasks up to concurrency limit
    const available = concurrency - runningCount;
    if (available > 0) {
      const pending = getPendingTasks(db, available);

      for (const task of pending) {
        // Skip tasks already being executed by this process
        if (runningTaskIds.has(task.id)) continue;

        // Atomically claim the task
        if (!claimTask(db, task.id, process.pid)) continue;

        runningCount++;
        runningTaskIds.add(task.id);
        lastActivityAt = Date.now();

        if (!quiet) {
          console.log(`${DIM}[executor]${RESET} > ${task.command} (${task.id.slice(0, 8)})`);
        }

        // Execute asynchronously — don't block the poll loop
        executeTask(task, task.cwd || workingDir, quiet).finally(() => {
          runningCount--;
          runningTaskIds.delete(task.id);
          lastActivityAt = Date.now();

          if (!quiet) {
            const row = getTaskById(db, task.id);
            const icon = row?.status === 'completed' ? '+' : 'x';
            console.log(`${DIM}[executor]${RESET} ${icon} ${task.command} (${task.id.slice(0, 8)}): ${row?.status || 'unknown'}`);
          }
        });
      }
    }

    // Idle timeout: shut down if no tasks are running and no activity for the configured period
    if (idleTimeoutMs > 0 && runningCount === 0 && (Date.now() - lastActivityAt) >= idleTimeoutMs) {
      if (!quiet) {
        console.log(`${DIM}[executor]${RESET} Idle timeout (${Math.round(idleTimeoutMs / 1000)}s). Shutting down.`);
      }
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Graceful shutdown: wait for running tasks to finish (30s timeout)
  if (runningCount > 0) {
    if (!quiet) {
      console.log(`${DIM}[executor]${RESET} Waiting for ${runningCount} running task(s) to finish...`);
    }
    const shutdownDeadline = Date.now() + 30_000;
    while (runningCount > 0 && Date.now() < shutdownDeadline) {
      await sleep(500);
    }
    if (runningCount > 0 && !quiet) {
      console.log(`${DIM}[executor]${RESET} ${runningCount} task(s) still running after timeout.`);
    }
  }

  await cleanup();
  if (!quiet) {
    console.log(`${DIM}[executor]${RESET} Shut down.`);
  }
}
