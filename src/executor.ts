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
import { FileSystemStateProvider } from './pipeline-state.js';
import { isInterrupted, triggerAbort } from './abort.js';
import { DIM, RESET, BOLD } from './display.js';
import type { GateKey, GateType, StageName } from './pipeline-types.js';

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

// ── Task dispatch ────────────────────────────────────────────

/**
 * Dispatch a task to the appropriate forge function based on the
 * command name and stored parameters. All functions are called with
 * quiet: true to prevent console noise in the shared executor process.
 */
async function dispatchTask(task: TaskRow, workingDir: string): Promise<void> {
  const params: Record<string, unknown> = JSON.parse(task.params || '{}');
  const cmd = task.command.replace(/^forge\s+/, '');
  const extraArgs = (params.extraArgs || []) as string[];

  switch (cmd) {
    case 'run': {
      const specPath = (params.specPath || task.specPath) as string | undefined;

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
          await runForge({
            prompt: task.description || 'implement',
            specDir: specPath,
            cwd: workingDir,
            model: params.model as string | undefined,
            quiet: true,
            sequential: extraArgs.includes('--sequential'),
            force: extraArgs.includes('--force') || extraArgs.includes('-F'),
          });
        } else {
          await runSingleSpec({
            prompt: task.description || 'implement',
            specPath,
            cwd: workingDir,
            model: params.model as string | undefined,
            quiet: true,
            _silent: true,
          });
        }
      } else {
        await runSingleSpec({
          prompt: task.description || '',
          cwd: workingDir,
          model: params.model as string | undefined,
          quiet: true,
          _silent: true,
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
        model: params.model as string | undefined,
        quiet: true,
        fix: extraArgs.includes('--fix'),
        fixRounds: extraArgs.includes('--fix-rounds')
          ? parseInt(extraArgs[extraArgs.indexOf('--fix-rounds') + 1], 10)
          : undefined,
      });
      break;
    }

    case 'define': {
      await runDefine({
        prompt: task.description || '',
        outputDir: params.outputDir as string | undefined,
        cwd: workingDir,
        model: params.model as string | undefined,
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
        model: params.model as string | undefined,
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
        model: params.model as string | undefined,
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

      const stateProvider = new FileSystemStateProvider(workingDir);
      await runPipeline(
        {
          goal: task.description || '',
          gates,
          fromStage: params.fromStage as StageName | undefined,
          specDir: params.specPath as string | undefined,
          cwd: workingDir,
          model: params.model as string | undefined,
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
    await dispatchTask(task, workingDir);

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

  if (!quiet) {
    console.log(`${BOLD}forge executor${RESET}`);
    console.log(`${DIM}Working directory:${RESET} ${workingDir}`);
    console.log(`${DIM}Concurrency:${RESET}      ${concurrency}`);
    console.log(`${DIM}PID:${RESET}              ${process.pid}`);
    console.log(`${DIM}Polling:${RESET}          ${POLL_INTERVAL_MS}ms\n`);
    console.log(`${DIM}Waiting for tasks...${RESET}\n`);
  }

  let runningCount = 0;
  const runningTaskIds = new Set<string>();

  while (!isInterrupted()) {
    const db = getDb(workingDir);
    if (!db) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Mark stale tasks (abandoned by dead processes)
    markStaleTasks(db, STALE_TASK_TTL_MS);

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

        if (!quiet) {
          console.log(`${DIM}[executor]${RESET} > ${task.command} (${task.id.slice(0, 8)})`);
        }

        // Execute asynchronously — don't block the poll loop
        executeTask(task, task.cwd || workingDir).finally(() => {
          runningCount--;
          runningTaskIds.delete(task.id);

          if (!quiet) {
            const row = getTaskById(db, task.id);
            const icon = row?.status === 'completed' ? '+' : 'x';
            console.log(`${DIM}[executor]${RESET} ${icon} ${task.command} (${task.id.slice(0, 8)}): ${row?.status || 'unknown'}`);
          }
        });
      }
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
