/**
 * TaskContext abstraction — replaces _skipTaskTracking / _taskId / _parentTaskId flags.
 *
 * Three implementations:
 * - DbTaskContext:       Creates and manages its own task row (CLI path)
 * - ExecutorTaskContext: Delegates to the executor's existing task row (queued tasks)
 * - NoopTaskContext:     Does nothing (tests, or when DB is unavailable)
 */

import crypto from 'crypto';
import type { Database } from 'bun:sqlite';
import { insertCliTask, updateTaskStatus, updateTaskSessionId, cancelTask } from './db.js';

// ── Interface ────────────────────────────────────────────────

/**
 * Abstraction for task lifecycle management during a forge run.
 * Decouples runSingleSpec from knowing whether it's running in
 * CLI mode, executor mode, or a test harness.
 */
export interface TaskContext {
  /** The task ID (for linking child tasks or DB lookups). */
  readonly taskId: string;

  /**
   * Update the task's status in the backing store.
   * @param status - The new status (e.g. 'completed', 'failed', 'cancelled')
   * @param exitCode - Optional exit code (0 = success)
   */
  updateStatus(status: string, exitCode?: number | null): void;

  /**
   * Link a session ID to this task record (for TUI drill-down, resume, etc.).
   * @param sessionId - The SDK session ID
   */
  linkSession(sessionId: string): void;

  /**
   * Cancel the task (sets status to 'cancelled' with a timestamp).
   */
  cancel(): void;
}

// ── DbTaskContext ────────────────────────────────────────────

/**
 * Creates and manages its own task row in the SQLite database.
 * Used by the CLI path where each run inserts a fresh task record.
 */
export class DbTaskContext implements TaskContext {
  readonly taskId: string;
  private readonly db: Database;

  constructor(
    db: Database,
    opts: {
      taskId?: string;
      command: string;
      description: string;
      specPath?: string | null;
      cwd: string;
      parentTaskId?: string | null;
    },
  ) {
    this.db = db;
    this.taskId = opts.taskId ?? crypto.randomUUID();

    try {
      insertCliTask(db, {
        id: this.taskId,
        command: opts.command,
        description: opts.description,
        specPath: opts.specPath ?? null,
        cwd: opts.cwd,
        parentTaskId: opts.parentTaskId ?? null,
      });
    } catch {
      // Best effort -- don't block execution if task insert fails
    }
  }

  updateStatus(status: string, exitCode?: number | null): void {
    try {
      updateTaskStatus(this.db, this.taskId, status, exitCode);
    } catch {
      // Best effort
    }
  }

  linkSession(sessionId: string): void {
    try {
      updateTaskSessionId(this.db, this.taskId, sessionId);
    } catch {
      // Best effort
    }
  }

  cancel(): void {
    try {
      cancelTask(this.db, this.taskId);
    } catch {
      // Best effort
    }
  }
}

// ── ExecutorTaskContext ───────────────────────────────────────

/**
 * Wraps an existing task row managed by the executor.
 * The executor already created the task and tracks its lifecycle;
 * this context is a no-op for all mutations to avoid double-writes.
 */
export class ExecutorTaskContext implements TaskContext {
  readonly taskId: string;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  updateStatus(_status: string, _exitCode?: number | null): void {
    // Executor manages task status externally — no-op here
  }

  linkSession(_sessionId: string): void {
    // Executor captures session IDs via directory snapshot — no-op here
  }

  cancel(): void {
    // Executor handles cancellation — no-op here
  }
}

// ── NoopTaskContext ──────────────────────────────────────────

/**
 * Does nothing. Used in tests or when the database is unavailable.
 */
export class NoopTaskContext implements TaskContext {
  readonly taskId: string;

  constructor(taskId?: string) {
    this.taskId = taskId ?? crypto.randomUUID();
  }

  updateStatus(_status: string, _exitCode?: number | null): void {
    // No-op
  }

  linkSession(_sessionId: string): void {
    // No-op
  }

  cancel(): void {
    // No-op
  }
}
