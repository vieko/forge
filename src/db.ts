// ── SQLite Database Layer ─────────────────────────────────────
//
// Lazy-initialized SQLite database using bun:sqlite with WAL mode.
// Provides schema versioning with sequential migrations.
// The database is local-only (.forge/forge.db) and gitignored.
// The sessions table is the primary store for session metadata.
// The runs table is the primary store for run results.

import { Database } from 'bun:sqlite';
import path from 'path';
import { promises as fs, statSync, mkdirSync } from 'fs';

// ── Types ────────────────────────────────────────────────────

export interface Migration {
  version: number;
  up: (db: Database) => void;
}

/** Row shape for the tasks table (unified task tracking: CLI + MCP). */
export interface TaskRow {
  id: string;
  command: string;
  description: string | null;
  specPath: string | null;
  status: string;
  pid: number | null;
  sessionId: string | null;
  stdout: string;  // JSON array of strings
  stderr: string;  // JSON array of strings
  exitCode: number | null;
  cwd: string;
  params: string;  // JSON object of task parameters for executor dispatch
  parentTaskId: string | null;  // FK to parent batch task (null for standalone or parent tasks)
  source: string;  // 'cli' or 'mcp', indicates entry point
  cancelledAt: string | null;  // ISO timestamp when cancelled (null otherwise)
  createdAt: string;
  updatedAt: string;
}

// ── Migrations ───────────────────────────────────────────────

/**
 * Ordered list of migrations. Each spec that adds tables appends here.
 * Version 1 creates only the schema_version table (bootstrapped separately).
 * Future migrations start at version 2+.
 */
export const migrations: Migration[] = [
  // Version 1: schema_version table is created by initSchema() itself.
  // No additional tables needed for the foundation spec.

  // Version 2: runs table — indexed store for run results
  {
    version: 2,
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          specPath TEXT,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          costUsd REAL,
          durationSeconds REAL NOT NULL,
          numTurns INTEGER,
          toolCalls INTEGER,
          batchId TEXT,
          type TEXT,
          prompt TEXT NOT NULL,
          cwd TEXT NOT NULL,
          sessionId TEXT,
          error TEXT,
          createdAt TEXT NOT NULL
        )
      `);
      // Indexes for common query patterns
      db.run('CREATE INDEX IF NOT EXISTS idx_runs_batchId ON runs (batchId)');
      db.run('CREATE INDEX IF NOT EXISTS idx_runs_createdAt ON runs (createdAt)');
      db.run('CREATE INDEX IF NOT EXISTS idx_runs_specPath ON runs (specPath)');
      db.run('CREATE INDEX IF NOT EXISTS idx_runs_model ON runs (model)');
      db.run('CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status)');
    },
  },

  // Version 3: Pipeline state tables (pipelines, stages, gates)
  {
    version: 3,
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS pipelines (
          id TEXT PRIMARY KEY,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          branch TEXT,
          worktree_path TEXT,
          total_cost REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS stages (
          pipeline_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          cost REAL NOT NULL DEFAULT 0,
          duration REAL NOT NULL DEFAULT 0,
          sessions TEXT NOT NULL DEFAULT '[]',
          artifacts TEXT NOT NULL DEFAULT '{}',
          started_at TEXT,
          completed_at TEXT,
          error TEXT,
          PRIMARY KEY (pipeline_id, name),
          FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS gates (
          pipeline_id TEXT NOT NULL,
          from_stage TEXT NOT NULL,
          to_stage TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'auto',
          status TEXT NOT NULL DEFAULT 'waiting',
          approved_at TEXT,
          PRIMARY KEY (pipeline_id, from_stage, to_stage),
          FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_pipelines_created_at ON pipelines(created_at DESC)');
      db.run('CREATE INDEX IF NOT EXISTS idx_pipelines_status ON pipelines(status)');
    },
  },

  // Version 4: sessions table — indexed session metadata
  {
    version: 4,
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          specPath TEXT,
          pipelineId TEXT,
          commandType TEXT,
          model TEXT,
          status TEXT,
          costUsd REAL,
          startedAt TEXT,
          endedAt TEXT
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_sessions_specPath ON sessions (specPath)');
      db.run('CREATE INDEX IF NOT EXISTS idx_sessions_pipelineId ON sessions (pipelineId)');
      db.run('CREATE INDEX IF NOT EXISTS idx_sessions_commandType ON sessions (commandType)');
      db.run('CREATE INDEX IF NOT EXISTS idx_sessions_startedAt ON sessions (startedAt DESC)');
    },
  },

  // Version 5: tasks table — persistent MCP task tracking
  {
    version: 5,
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          description TEXT,
          specPath TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          pid INTEGER,
          sessionId TEXT,
          stdout TEXT NOT NULL DEFAULT '[]',
          stderr TEXT NOT NULL DEFAULT '[]',
          exitCode INTEGER,
          cwd TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
      db.run('CREATE INDEX IF NOT EXISTS idx_tasks_cwd_command ON tasks(cwd, command)');
    },
  },

  // Version 6: Add params column to tasks table (executor dispatch parameters)
  {
    version: 6,
    up: (db: Database) => {
      db.run(`ALTER TABLE tasks ADD COLUMN params TEXT NOT NULL DEFAULT '{}'`);
    },
  },

  // Version 7: Unified task tracking — CLI + MCP write to the same tasks table
  {
    version: 7,
    up: (db: Database) => {
      // parentTaskId: FK to parent batch task (null for standalone or parent tasks)
      db.run(`ALTER TABLE tasks ADD COLUMN parentTaskId TEXT`);
      // source: 'cli' or 'mcp', indicates entry point
      db.run(`ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'cli'`);
      // cancelledAt: ISO timestamp when cancelled
      db.run(`ALTER TABLE tasks ADD COLUMN cancelledAt TEXT`);
      // Index for child task lookups
      db.run('CREATE INDEX IF NOT EXISTS idx_tasks_parentTaskId ON tasks(parentTaskId)');
      // Index for source-based queries
      db.run('CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source)');
    },
  },

  // Version 8: Add pid column to pipelines table for stale pipeline detection
  {
    version: 8,
    up: (db: Database) => {
      db.run(`ALTER TABLE pipelines ADD COLUMN pid INTEGER`);
    },
  },

  // Version 9: spec_entries and spec_runs tables — DB-primary spec lifecycle tracking
  {
    version: 9,
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS spec_entries (
          id TEXT PRIMARY KEY,
          spec TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL DEFAULT 'file',
          work_group_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_spec_entries_status ON spec_entries(status)');
      db.run('CREATE INDEX IF NOT EXISTS idx_spec_entries_work_group_id ON spec_entries(work_group_id)');

      db.run(`
        CREATE TABLE IF NOT EXISTS spec_runs (
          id TEXT PRIMARY KEY,
          spec_entry_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          status TEXT NOT NULL,
          cost_usd REAL,
          duration_seconds REAL,
          num_turns INTEGER,
          verify_attempts INTEGER,
          FOREIGN KEY (spec_entry_id) REFERENCES spec_entries(id)
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_spec_runs_spec_entry_id ON spec_runs(spec_entry_id)');
      db.run('CREATE INDEX IF NOT EXISTS idx_spec_runs_run_id ON spec_runs(run_id)');
    },
  },

  // Version 10: worktrees table — registry for worktree lifecycle tracking
  //
  // NOTE: Migration versions 10 and 11 are defined here, but the worktrees
  // table (v10) was the last migration before the consolidations guard (v11).
  {
    version: 10,
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS worktrees (
          id TEXT PRIMARY KEY,
          work_group_id TEXT,
          spec_path TEXT NOT NULL,
          spec_paths TEXT NOT NULL DEFAULT '[]',
          branch TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'created' CHECK (
            status IN (
              'created', 'running', 'complete', 'failed',
              'auditing', 'audited', 'proofing', 'proofed',
              'ready', 'paused', 'merging', 'merge_failed', 'merged', 'cleaned'
            )
          ),
          linear_issue_id TEXT,
          pid INTEGER,
          task_id TEXT,
          session_id TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.run('CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status)');
      db.run('CREATE INDEX IF NOT EXISTS idx_worktrees_work_group_id ON worktrees(work_group_id)');
      db.run('CREATE INDEX IF NOT EXISTS idx_worktrees_branch ON worktrees(branch)');
      db.run('CREATE INDEX IF NOT EXISTS idx_worktrees_task_id ON worktrees(task_id)');
    },
  },

  // Version 11: consolidations table — PID-based concurrency guard for forge consolidate
  {
    version: 11,
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS consolidations (
          work_group_id TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          started_at TEXT NOT NULL
        )
      `);
    },
  },
];

// ── Schema initialization ────────────────────────────────────

/**
 * Create the schema_version table if it does not exist and run
 * any pending migrations sequentially from the current version.
 */
function initSchema(db: Database): void {
  // Create the version tracking table (idempotent)
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Seed with version 0 if empty (first run)
  const row = db.query('SELECT version FROM schema_version WHERE id = 1').get() as
    | { version: number }
    | null;

  let currentVersion: number;
  if (row === null) {
    db.run('INSERT INTO schema_version (id, version) VALUES (1, 0)');
    currentVersion = 0;
  } else {
    currentVersion = row.version;
  }

  // Run pending migrations inside a transaction
  const pending = migrations.filter(m => m.version > currentVersion);
  if (pending.length === 0) return;

  // Sort by version to guarantee order
  pending.sort((a, b) => a.version - b.version);

  db.transaction(() => {
    for (const migration of pending) {
      migration.up(db);
      db.run(
        'UPDATE schema_version SET version = ?, updated_at = datetime(\'now\') WHERE id = 1',
        [migration.version],
      );
    }
  })();
}

// ── Database instance cache ──────────────────────────────────

const dbCache = new Map<string, Database>();

/**
 * Get (or create) a SQLite database for the given working directory.
 * The database is cached per resolved path — subsequent calls with the
 * same directory return the same instance.
 *
 * Returns null if bun:sqlite is unavailable or the database cannot be
 * opened (graceful degradation).
 */
export function getDb(workingDir: string): Database | null {
  const dbPath = path.join(workingDir, '.forge', 'forge.db');
  const resolved = path.resolve(dbPath);

  // Return cached instance if available
  const cached = dbCache.get(resolved);
  if (cached) return cached;

  try {
    // Ensure .forge/ directory exists (sync for simplicity — getDb is lazy)
    const forgeDir = path.join(workingDir, '.forge');
    try {
      const st = statSync(forgeDir);
      if (!st.isDirectory()) return null;
    } catch {
      mkdirSync(forgeDir, { recursive: true });
    }

    const db = new Database(resolved);

    // Enable WAL mode for concurrent readers + single writer
    db.run('PRAGMA journal_mode=WAL');

    // Handle multi-process write contention gracefully
    db.run('PRAGMA busy_timeout=5000');

    // Keep WAL file size bounded
    db.run('PRAGMA wal_autocheckpoint=1000');

    // Run schema initialization and pending migrations
    initSchema(db);

    // Cache the instance
    dbCache.set(resolved, db);

    return db;
  } catch (err) {
    // Graceful degradation: warn and return null
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[forge] SQLite unavailable: ${message}`);
    return null;
  }
}

// ── Test helper ──────────────────────────────────────────────

/**
 * Create an in-memory SQLite database with all migrations applied.
 * Used by test files for isolation — each call returns a fresh instance.
 */
export function getTestDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA busy_timeout=5000');
  db.run('PRAGMA wal_autocheckpoint=1000');
  initSchema(db);
  return db;
}

// ── Cleanup ──────────────────────────────────────────────────

/**
 * Close a cached database instance and remove it from the cache.
 * Primarily for testing and graceful shutdown.
 */
export function closeDb(workingDir: string): void {
  const dbPath = path.resolve(path.join(workingDir, '.forge', 'forge.db'));
  const db = dbCache.get(dbPath);
  if (db) {
    try {
      db.close();
    } catch {
      // Best effort — don't throw during cleanup
    }
    dbCache.delete(dbPath);
  }
}

/**
 * Close all cached database instances. Called during process shutdown.
 */
export function closeAllDbs(): void {
  for (const [key, db] of dbCache) {
    try {
      db.close();
    } catch {
      // Best effort
    }
    dbCache.delete(key);
  }
}

/**
 * Get the current schema version from a database instance.
 * Returns 0 if the schema_version table exists but has no rows,
 * or -1 if the table does not exist.
 */
export function getSchemaVersion(db: Database): number {
  try {
    const row = db.query('SELECT version FROM schema_version WHERE id = 1').get() as
      | { version: number }
      | null;
    return row?.version ?? 0;
  } catch {
    return -1;
  }
}

// ── Runs table helpers ───────────────────────────────────────

/** Row shape returned from SELECT on the runs table. */
export interface RunRow {
  id: string;
  specPath: string | null;
  model: string;
  status: string;
  costUsd: number | null;
  durationSeconds: number;
  numTurns: number | null;
  toolCalls: number | null;
  batchId: string | null;
  type: string | null;
  prompt: string;
  cwd: string;
  sessionId: string | null;
  error: string | null;
  createdAt: string;
}

/**
 * Insert a run into the runs table. Uses INSERT OR IGNORE so
 * duplicate IDs are silently skipped (idempotent).
 */
export function insertRun(db: Database, row: RunRow): void {
  db.run(
    `INSERT OR IGNORE INTO runs
      (id, specPath, model, status, costUsd, durationSeconds, numTurns, toolCalls, batchId, type, prompt, cwd, sessionId, error, createdAt)
     VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.specPath,
      row.model,
      row.status,
      row.costUsd,
      row.durationSeconds,
      row.numTurns,
      row.toolCalls,
      row.batchId,
      row.type,
      row.prompt,
      row.cwd,
      row.sessionId,
      row.error,
      row.createdAt,
    ],
  );
}

/** Aggregate stats row shape from SQL queries. */
export interface AggregateRow {
  total: number;
  passed: number;
  failed: number;
  totalCost: number;
  totalDuration: number;
  totalTurns: number;
  runsWithTurns: number;
}

/**
 * Query aggregate stats from the runs table.
 * Optional `since` ISO date filters by createdAt >= since.
 */
export function queryAggregateStats(db: Database, since?: string): AggregateRow {
  const whereClause = since ? 'WHERE createdAt >= ?' : '';
  const params = since ? [since] : [];

  const row = db.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failed,
      COALESCE(SUM(costUsd), 0) as totalCost,
      COALESCE(SUM(durationSeconds), 0) as totalDuration,
      COALESCE(SUM(CASE WHEN numTurns IS NOT NULL THEN numTurns ELSE 0 END), 0) as totalTurns,
      SUM(CASE WHEN numTurns IS NOT NULL THEN 1 ELSE 0 END) as runsWithTurns
    FROM runs ${whereClause}
  `).get(...params) as AggregateRow;

  return row;
}

/** Per-spec stats row from SQL GROUP BY. */
export interface SpecStatsRow {
  specPath: string;
  runs: number;
  passed: number;
  avgCost: number;
  avgDuration: number;
}

/**
 * Query per-spec stats from the runs table grouped by specPath.
 * Optional `since` ISO date filters by createdAt >= since.
 */
export function querySpecStats(db: Database, since?: string): SpecStatsRow[] {
  const whereClause = since
    ? 'WHERE specPath IS NOT NULL AND createdAt >= ?'
    : 'WHERE specPath IS NOT NULL';
  const params = since ? [since] : [];

  const rows = db.query(`
    SELECT
      specPath,
      COUNT(*) as runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as passed,
      COALESCE(AVG(costUsd), 0) as avgCost,
      AVG(durationSeconds) as avgDuration
    FROM runs ${whereClause}
    GROUP BY specPath
    ORDER BY runs DESC
  `).all(...params) as SpecStatsRow[];

  return rows;
}

/** Per-model stats row from SQL GROUP BY. */
export interface ModelStatsRow {
  model: string;
  runs: number;
  passed: number;
  avgCost: number;
  avgDuration: number;
}

/**
 * Query per-model stats from the runs table grouped by model.
 * Optional `since` ISO date filters by createdAt >= since.
 */
export function queryModelStats(db: Database, since?: string): ModelStatsRow[] {
  const whereClause = since ? 'WHERE createdAt >= ?' : '';
  const params = since ? [since] : [];

  const rows = db.query(`
    SELECT
      model,
      COUNT(*) as runs,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as passed,
      COALESCE(AVG(costUsd), 0) as avgCost,
      AVG(durationSeconds) as avgDuration
    FROM runs ${whereClause}
    GROUP BY model
    ORDER BY runs DESC
  `).all(...params) as ModelStatsRow[];

  return rows;
}

/** Run row shape for status display. */
export interface StatusRunRow {
  id: string;
  specPath: string | null;
  model: string;
  status: string;
  costUsd: number | null;
  durationSeconds: number;
  numTurns: number | null;
  batchId: string | null;
  startedAt: string;
}

/**
 * Query runs for status display, ordered by createdAt DESC.
 * Returns all runs — grouping by batchId is done by the caller.
 */
export function queryStatusRuns(db: Database): StatusRunRow[] {
  const rows = db.query(`
    SELECT
      id,
      specPath,
      model,
      status,
      costUsd,
      durationSeconds,
      numTurns,
      batchId,
      createdAt as startedAt
    FROM runs
    ORDER BY createdAt DESC
  `).all() as StatusRunRow[];

  return rows;
}


// ── Sessions table helpers ────────────────────────────────────

/** Row shape for the sessions table. */
export interface SessionRow {
  id: string;
  specPath: string | null;
  pipelineId: string | null;
  commandType: string | null;
  model: string | null;
  status: string | null;
  costUsd: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Insert a session row when a session starts.
 * Uses INSERT OR IGNORE so duplicate IDs are silently skipped (idempotent).
 */
export function insertSession(db: Database, row: {
  id: string;
  specPath?: string | null;
  pipelineId?: string | null;
  commandType?: string | null;
  model?: string | null;
  startedAt: string;
}): void {
  db.run(
    `INSERT OR IGNORE INTO sessions
      (id, specPath, pipelineId, commandType, model, status, startedAt)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    [
      row.id,
      row.specPath ?? null,
      row.pipelineId ?? null,
      row.commandType ?? null,
      row.model ?? null,
      row.startedAt,
    ],
  );
}

/**
 * Update a session row when the session completes (success or error).
 */
export function updateSession(db: Database, id: string, updates: {
  status: string;
  costUsd?: number | null;
  endedAt: string;
}): void {
  db.run(
    `UPDATE sessions SET status = ?, costUsd = ?, endedAt = ? WHERE id = ?`,
    [updates.status, updates.costUsd ?? null, updates.endedAt, id],
  );
}

/**
 * Query sessions filtered by specPath, ordered by startedAt DESC.
 */
export function querySessionsBySpec(db: Database, specPath: string): SessionRow[] {
  return db.query(
    `SELECT * FROM sessions WHERE specPath = ? ORDER BY startedAt DESC`,
  ).all(specPath) as SessionRow[];
}

/**
 * Query sessions filtered by pipelineId, ordered by startedAt DESC.
 */
export function querySessionsByPipeline(db: Database, pipelineId: string): SessionRow[] {
  return db.query(
    `SELECT * FROM sessions WHERE pipelineId = ? ORDER BY startedAt DESC`,
  ).all(pipelineId) as SessionRow[];
}

/**
 * Query sessions filtered by commandType, ordered by startedAt DESC.
 */
export function querySessionsByCommandType(db: Database, commandType: string): SessionRow[] {
  return db.query(
    `SELECT * FROM sessions WHERE commandType = ? ORDER BY startedAt DESC`,
  ).all(commandType) as SessionRow[];
}

/**
 * Query all sessions ordered by startedAt DESC, with optional limit.
 */
export function queryAllSessions(db: Database, limit?: number): SessionRow[] {
  if (limit) {
    return db.query(
      `SELECT * FROM sessions ORDER BY startedAt DESC LIMIT ?`,
    ).all(limit) as SessionRow[];
  }
  return db.query(
    `SELECT * FROM sessions ORDER BY startedAt DESC`,
  ).all() as SessionRow[];
}


// ── Gitignore helper ─────────────────────────────────────────

/**
 * Ensure .forge/.gitignore includes the database files.
 * Called by ensureForgeDir() — this function only appends if the
 * entries are missing (idempotent).
 */
export async function ensureDbGitignore(forgeDir: string): Promise<void> {
  const gitignorePath = path.join(forgeDir, '.gitignore');
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    // The existing gitignore uses `*` to ignore everything except allowlisted files.
    // Since `*` already covers forge.db, forge.db-wal, and forge.db-shm,
    // no changes are needed — the DB files are already gitignored by the wildcard.
    // This function exists as a safety check and for documentation purposes.
    if (content.includes('*')) return;

    // If someone replaced the gitignore with a non-wildcard approach,
    // append specific DB file entries
    const dbEntries = ['forge.db', 'forge.db-wal', 'forge.db-shm'];
    const missing = dbEntries.filter(entry => !content.includes(entry));
    if (missing.length > 0) {
      const append = '\n# SQLite database (local only)\n' + missing.map(e => e).join('\n') + '\n';
      await fs.appendFile(gitignorePath, append);
    }
  } catch {
    // .gitignore doesn't exist yet — ensureForgeDir will create it with `*`
  }
}

// ── Task CRUD ─────────────────────────────────────────────────

/**
 * Insert a task row into the tasks table.
 * Called by MCP forge_start to queue a pending task for the executor,
 * or by CLI commands to record a running task.
 */
export function insertTask(db: Database, task: {
  id: string;
  command: string;
  description?: string | null;
  specPath?: string | null;
  status: string;
  pid?: number | null;
  sessionId?: string | null;
  stdout?: string[];
  stderr?: string[];
  exitCode?: number | null;
  cwd: string;
  params?: Record<string, unknown>;
  parentTaskId?: string | null;
  source?: string;
}): void {
  const now = new Date().toISOString();
  const startedAt = task.status === 'running' ? now : null;
  db.run(
    `INSERT INTO tasks (id, command, description, specPath, status, pid, sessionId, stdout, stderr, exitCode, cwd, params, parentTaskId, source, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.command,
      task.description ?? null,
      task.specPath ?? null,
      task.status,
      task.pid ?? null,
      task.sessionId ?? null,
      JSON.stringify(task.stdout ?? []),
      JSON.stringify(task.stderr ?? []),
      task.exitCode ?? null,
      task.cwd,
      JSON.stringify(task.params ?? {}),
      task.parentTaskId ?? null,
      task.source ?? 'cli',
      now,
      now,
    ],
  );
}

/**
 * Insert a CLI task that is already running (no queue hop).
 * Convenience wrapper around insertTask with CLI-specific defaults.
 */
export function insertCliTask(db: Database, task: {
  id: string;
  command: string;
  description?: string | null;
  specPath?: string | null;
  cwd: string;
  parentTaskId?: string | null;
}): void {
  insertTask(db, {
    ...task,
    status: 'running',
    pid: process.pid,
    source: 'cli',
  });
}

/**
 * Cancel a task: set status to 'cancelled', record cancelledAt timestamp.
 * Returns true if the task was updated (was running or pending).
 */
export function cancelTask(db: Database, id: string): boolean {
  const now = new Date().toISOString();
  db.run(
    `UPDATE tasks SET status = 'cancelled', cancelledAt = ?, updatedAt = ? WHERE id = ? AND status IN ('running', 'pending')`,
    [now, now, id],
  );
  const row = db.query('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string } | null;
  return row?.status === 'cancelled';
}

/**
 * Get child tasks for a parent batch task.
 */
export function getChildTasks(db: Database, parentTaskId: string): TaskRow[] {
  return db.query(
    'SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY createdAt ASC',
  ).all(parentTaskId) as TaskRow[];
}

/**
 * Query recent tasks for status display, ordered by createdAt DESC.
 * Includes both CLI and MCP tasks.
 */
export function queryRecentTasks(db: Database, limit?: number): TaskRow[] {
  if (limit) {
    return db.query(
      'SELECT * FROM tasks ORDER BY createdAt DESC LIMIT ?',
    ).all(limit) as TaskRow[];
  }
  return db.query(
    'SELECT * FROM tasks ORDER BY createdAt DESC',
  ).all() as TaskRow[];
}

/** Per-source stats row from SQL GROUP BY. */
export interface SourceStatsRow {
  source: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/**
 * Query per-source task stats from the tasks table grouped by source.
 * Optional `since` ISO date filters by createdAt >= since.
 */
export function querySourceStats(db: Database, since?: string): SourceStatsRow[] {
  const whereClause = since ? 'WHERE createdAt >= ?' : '';
  const params = since ? [since] : [];

  const rows = db.query(`
    SELECT
      source,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
    FROM tasks
    WHERE parentTaskId IS NULL ${since ? 'AND createdAt >= ?' : ''}
    GROUP BY source
    ORDER BY total DESC
  `).all(...params) as SourceStatsRow[];

  return rows;
}

/**
 * Get a task by its ID. Returns null if not found.
 */
export function getTaskById(db: Database, id: string): TaskRow | null {
  return db.query('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | null;
}

/**
 * Update a task's status and optional exit code.
 * Refreshes updatedAt as a heartbeat signal.
 */
export function updateTaskStatus(db: Database, id: string, status: string, exitCode?: number | null): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE tasks SET status = ?, exitCode = ?, updatedAt = ? WHERE id = ?',
    [status, exitCode ?? null, now, id],
  );
}

/**
 * Update a task's stdout and stderr buffers.
 * Called on each child process data event — refreshes updatedAt as heartbeat.
 */
export function updateTaskOutput(db: Database, id: string, stdout: string[], stderr: string[]): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE tasks SET stdout = ?, stderr = ?, updatedAt = ? WHERE id = ?',
    [JSON.stringify(stdout), JSON.stringify(stderr), now, id],
  );
}

/**
 * Update a task's sessionId (captured from latest-session.json after child starts).
 */
export function updateTaskSessionId(db: Database, id: string, sessionId: string): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE tasks SET sessionId = ?, updatedAt = ? WHERE id = ?',
    [sessionId, now, id],
  );
}

/**
 * Mark stale running tasks as failed.
 *
 * Two detection strategies:
 * 1. TTL-based: Tasks with updatedAt older than TTL are considered abandoned.
 * 2. PID liveness: Tasks (especially CLI source) whose PID is no longer alive
 *    are marked as failed immediately, regardless of TTL.
 *
 * This catches both executor tasks that timed out and CLI processes that crashed.
 */
export function markStaleTasks(db: Database, ttlMs: number): void {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - ttlMs).toISOString();

  // Strategy 1: TTL-based (original behavior)
  db.run(
    `UPDATE tasks SET status = 'failed', updatedAt = ? WHERE status = 'running' AND updatedAt < ?`,
    [now, cutoff],
  );

  // Strategy 2: PID liveness check for running tasks with a PID
  const runningWithPid = db.query(
    `SELECT id, pid FROM tasks WHERE status = 'running' AND pid IS NOT NULL`,
  ).all() as Array<{ id: string; pid: number }>;

  for (const task of runningWithPid) {
    try {
      // Signal 0: check if process exists without killing it
      process.kill(task.pid, 0);
    } catch {
      // Process is dead — mark task as failed
      db.run(
        `UPDATE tasks SET status = 'failed', updatedAt = ? WHERE id = ? AND status = 'running'`,
        [now, task.id],
      );
    }
  }
}

/**
 * Find a running task by command name and working directory.
 * Used to guard against duplicate pipeline spawns for the same repo.
 */
export function getRunningTaskByCommandAndCwd(db: Database, command: string, cwd: string): TaskRow | null {
  return db.query(
    `SELECT * FROM tasks WHERE command = ? AND cwd = ? AND status = 'running' ORDER BY createdAt DESC LIMIT 1`,
  ).get(command, cwd) as TaskRow | null;
}

/**
 * Find an active (pending or running) task by command name and working directory.
 * Used by MCP to guard against duplicate pipeline/task submissions.
 */
export function getActiveTaskByCommandAndCwd(db: Database, command: string, cwd: string): TaskRow | null {
  return db.query(
    `SELECT * FROM tasks WHERE command = ? AND cwd = ? AND status IN ('running', 'pending') ORDER BY createdAt DESC LIMIT 1`,
  ).get(command, cwd) as TaskRow | null;
}

/**
 * Query active tasks (pending or running), sorted: running first, then pending, by createdAt.
 * Used by the TUI to display the executor task queue.
 */
export function getActiveTasks(db: Database): TaskRow[] {
  return db.query(
    `SELECT * FROM tasks WHERE status IN ('pending', 'running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, createdAt ASC`,
  ).all() as TaskRow[];
}

/**
 * Query recently completed or failed tasks within a time window.
 * Used by the TUI task history view (e.g. last hour).
 */
export function getRecentCompletedTasks(db: Database, sinceMs: number): TaskRow[] {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  return db.query(
    `SELECT * FROM tasks WHERE status IN ('completed', 'failed') AND updatedAt >= ? ORDER BY updatedAt DESC`,
  ).all(cutoff) as TaskRow[];
}

/**
 * Query pending tasks ordered by creation time (FIFO).
 * Used by the executor daemon to pick up work.
 */
export function getPendingTasks(db: Database, limit: number): TaskRow[] {
  return db.query(
    `SELECT * FROM tasks WHERE status = 'pending' ORDER BY createdAt ASC LIMIT ?`,
  ).all(limit) as TaskRow[];
}

/**
 * Attempt to claim a pending task by setting status to 'running' and recording the executor PID.
 * Returns true if the task was successfully claimed (status was still 'pending').
 * SQLite single-writer guarantees atomicity — only one executor can claim a given task.
 */
export function claimTask(db: Database, taskId: string, pid: number): boolean {
  const now = new Date().toISOString();
  db.run(
    `UPDATE tasks SET status = 'running', pid = ?, updatedAt = ? WHERE id = ? AND status = 'pending'`,
    [pid, now, taskId],
  );
  // Verify the claim succeeded
  const row = db.query('SELECT status, pid FROM tasks WHERE id = ?').get(taskId) as
    | { status: string; pid: number | null }
    | null;
  return row?.status === 'running' && row?.pid === pid;
}

// ── Spec Entries table helpers ────────────────────────────────

/** Row shape for the spec_entries table. */
export interface SpecEntryRow {
  id: string;
  spec: string;
  status: string;
  source: string;
  work_group_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Insert a spec entry. Uses INSERT OR IGNORE so duplicate IDs are silently skipped.
 */
export function insertSpecEntry(db: Database, entry: {
  id: string;
  spec: string;
  status?: string;
  source?: string;
  work_group_id?: string | null;
}): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO spec_entries (id, spec, status, source, work_group_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.spec,
      entry.status ?? 'pending',
      entry.source ?? 'file',
      entry.work_group_id ?? null,
      now,
      now,
    ],
  );
}

/**
 * Get a spec entry by its ID. Returns null if not found.
 */
export function getSpecEntry(db: Database, id: string): SpecEntryRow | null {
  return db.query('SELECT * FROM spec_entries WHERE id = ?').get(id) as SpecEntryRow | null;
}

/**
 * Get a spec entry by its spec path. Returns null if not found.
 */
export function getSpecEntryByPath(db: Database, specPath: string): SpecEntryRow | null {
  return db.query('SELECT * FROM spec_entries WHERE spec = ?').get(specPath) as SpecEntryRow | null;
}

/**
 * Update a spec entry's status. Refreshes updated_at.
 */
export function updateSpecEntryStatus(db: Database, id: string, status: string): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE spec_entries SET status = ?, updated_at = ? WHERE id = ?',
    [status, now, id],
  );
}

/**
 * List spec entries with optional status filter.
 * Ordered by created_at ASC (registration order).
 */
export function listSpecEntries(db: Database, filter?: { status?: string; work_group_id?: string }): SpecEntryRow[] {
  const conditions: string[] = [];
  const params: string[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.work_group_id) {
    conditions.push('work_group_id = ?');
    params.push(filter.work_group_id);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.query(
    `SELECT * FROM spec_entries ${whereClause} ORDER BY created_at ASC`,
  ).all(...params) as SpecEntryRow[];
}

/**
 * List spec entries for a given work group ID.
 * Ordered by created_at ASC (registration order).
 */
export function listSpecEntriesByWorkGroup(db: Database, workGroupId: string): SpecEntryRow[] {
  return db.query(
    'SELECT * FROM spec_entries WHERE work_group_id = ? ORDER BY created_at ASC',
  ).all(workGroupId) as SpecEntryRow[];
}

/**
 * Delete a spec entry by its ID. Also deletes associated spec_runs (cascade).
 */
export function deleteSpecEntry(db: Database, id: string): void {
  db.run('DELETE FROM spec_runs WHERE spec_entry_id = ?', [id]);
  db.run('DELETE FROM spec_entries WHERE id = ?', [id]);
}


// ── Spec Runs table helpers ──────────────────────────────────

/** Row shape for the spec_runs table. */
export interface SpecRunRow {
  id: string;
  spec_entry_id: string;
  run_id: string;
  timestamp: string;
  status: string;
  cost_usd: number | null;
  duration_seconds: number | null;
  num_turns: number | null;
  verify_attempts: number | null;
}

/**
 * Insert a spec run. Uses INSERT OR IGNORE so duplicate IDs are silently skipped.
 */
export function insertSpecRun(db: Database, run: {
  id: string;
  spec_entry_id: string;
  run_id: string;
  timestamp: string;
  status: string;
  cost_usd?: number | null;
  duration_seconds?: number | null;
  num_turns?: number | null;
  verify_attempts?: number | null;
}): void {
  db.run(
    `INSERT OR IGNORE INTO spec_runs (id, spec_entry_id, run_id, timestamp, status, cost_usd, duration_seconds, num_turns, verify_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      run.spec_entry_id,
      run.run_id,
      run.timestamp,
      run.status,
      run.cost_usd ?? null,
      run.duration_seconds ?? null,
      run.num_turns ?? null,
      run.verify_attempts ?? null,
    ],
  );
}

/**
 * Get all runs for a spec entry, ordered by timestamp DESC (most recent first).
 */
export function getSpecRunsByEntry(db: Database, specEntryId: string): SpecRunRow[] {
  return db.query(
    'SELECT * FROM spec_runs WHERE spec_entry_id = ? ORDER BY timestamp DESC',
  ).all(specEntryId) as SpecRunRow[];
}

/**
 * Get the latest run for a spec entry. Returns null if no runs exist.
 */
export function getLatestSpecRun(db: Database, specEntryId: string): SpecRunRow | null {
  return db.query(
    'SELECT * FROM spec_runs WHERE spec_entry_id = ? ORDER BY timestamp DESC LIMIT 1',
  ).get(specEntryId) as SpecRunRow | null;
}

// ── Worktrees table helpers ──────────────────────────────────

/** Valid status values for a worktree. */
export type WorktreeStatus =
  | 'created'
  | 'running'
  | 'complete'
  | 'failed'
  | 'auditing'
  | 'audited'
  | 'proofing'
  | 'proofed'
  | 'ready'
  | 'paused'
  | 'merging'
  | 'merge_failed'
  | 'merged'
  | 'cleaned';

/** Row shape for the worktrees table. */
export interface WorktreeRow {
  id: string;
  work_group_id: string | null;
  spec_path: string;
  spec_paths: string;   // JSON array of spec paths
  branch: string;
  worktree_path: string;
  status: WorktreeStatus;
  linear_issue_id: string | null;
  pid: number | null;
  task_id: string | null;
  session_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Insert a worktree into the worktrees table.
 * Uses INSERT OR IGNORE so duplicate IDs are silently skipped (idempotent).
 */
export function insertWorktree(db: Database, worktree: {
  id: string;
  work_group_id?: string | null;
  spec_path: string;
  spec_paths?: string[];
  branch: string;
  worktree_path: string;
  status?: WorktreeStatus;
  linear_issue_id?: string | null;
  pid?: number | null;
  task_id?: string | null;
  session_id?: string | null;
  error?: string | null;
}): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO worktrees
      (id, work_group_id, spec_path, spec_paths, branch, worktree_path, status, linear_issue_id, pid, task_id, session_id, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      worktree.id,
      worktree.work_group_id ?? null,
      worktree.spec_path,
      JSON.stringify(worktree.spec_paths ?? []),
      worktree.branch,
      worktree.worktree_path,
      worktree.status ?? 'created',
      worktree.linear_issue_id ?? null,
      worktree.pid ?? null,
      worktree.task_id ?? null,
      worktree.session_id ?? null,
      worktree.error ?? null,
      now,
      now,
    ],
  );
}

/**
 * Get a worktree by its ID. Returns null if not found.
 */
export function getWorktree(db: Database, id: string): WorktreeRow | null {
  return db.query('SELECT * FROM worktrees WHERE id = ?').get(id) as WorktreeRow | null;
}

/**
 * Get a worktree by its filesystem path. Returns null if not found.
 */
export function getWorktreeByPath(db: Database, worktreePath: string): WorktreeRow | null {
  return db.query(
    'SELECT * FROM worktrees WHERE worktree_path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get(worktreePath) as WorktreeRow | null;
}

/**
 * Get a worktree by its branch name. Returns null if not found.
 */
export function getWorktreeByBranch(db: Database, branch: string): WorktreeRow | null {
  return db.query(
    'SELECT * FROM worktrees WHERE branch = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get(branch) as WorktreeRow | null;
}

/**
 * Update a worktree's status. Optionally set error message (cleared on non-error transitions).
 * Refreshes updated_at timestamp.
 *
 * NOTE: Prefer `transitionWorktreeStatus()` for enforced lifecycle transitions.
 * This low-level function bypasses the state machine and should only be used
 * for initial setup or tests that need direct status control.
 */
export function updateWorktreeStatus(db: Database, id: string, status: WorktreeStatus, error?: string | null): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE worktrees SET status = ?, error = ?, updated_at = ? WHERE id = ?',
    [status, error ?? null, now, id],
  );
}

/**
 * Update a worktree's spec_paths JSON array.
 * Used after spec discovery to record all individual spec file paths.
 */
export function updateWorktreeSpecPaths(db: Database, id: string, specPaths: string[]): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE worktrees SET spec_paths = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(specPaths), now, id],
  );
}

// ── Worktree State Machine ──────────────────────────────────

/**
 * Valid status transitions for the worktree lifecycle.
 *
 * The lifecycle is user-paced: forge run sets `complete`, user triggers
 * audit which sets `auditing`/`audited`, etc.
 *
 * Transitions:
 *   created   -> running, failed (setup failure)
 *   running   -> complete, failed
 *   complete  -> auditing, proofing (skip audit), ready (skip audit+proof)
 *   failed    -> created (retry -- resets to beginning of lifecycle)
 *   auditing  -> audited, failed
 *   audited   -> proofing
 *   proofing  -> proofed, failed
 *   proofed   -> ready
 *   ready     -> merging
 *   merging   -> merged, merge_failed (type-check failure), paused (git conflict)
 *   paused    -> merging (resume after manual fix)
 *   merge_failed -> ready (retry consolidation)
 *   merged    -> cleaned
 *   cleaned   -> (terminal)
 */
const VALID_TRANSITIONS: Record<WorktreeStatus, WorktreeStatus[]> = {
  created:      ['running', 'failed'],
  running:      ['complete', 'failed'],
  complete:     ['auditing', 'proofing', 'ready'],
  failed:       ['created'],
  auditing:     ['audited', 'failed'],
  audited:      ['proofing', 'ready'],
  proofing:     ['proofed', 'failed'],
  proofed:      ['ready'],
  ready:        ['merging'],
  merging:      ['merged', 'merge_failed', 'paused'],
  paused:       ['merging'],
  merge_failed: ['ready'],
  merged:       ['cleaned'],
  cleaned:      [],
};

/**
 * Transition a worktree to a new status with state machine enforcement.
 *
 * Validates that the transition from the current status to `newStatus`
 * is allowed by the lifecycle state machine. Throws an error on invalid
 * transitions. Updates `updated_at` on every transition.
 *
 * Logs the transition to stderr for audit trail (captured in session
 * stream.log when running inside a forge session).
 *
 * Returns the previous status for logging/audit purposes.
 *
 * @throws Error if the worktree is not found or the transition is invalid.
 */
export function transitionWorktreeStatus(
  db: Database,
  id: string,
  newStatus: WorktreeStatus,
  error?: string | null,
): { previousStatus: WorktreeStatus } {
  const row = getWorktree(db, id);
  if (!row) {
    throw new Error(`Worktree not found: ${id}`);
  }

  const currentStatus = row.status;
  const allowed = VALID_TRANSITIONS[currentStatus];

  if (!allowed || !allowed.includes(newStatus)) {
    throw new Error(
      `Invalid worktree transition: ${currentStatus} -> ${newStatus} ` +
      `(allowed from ${currentStatus}: ${allowed?.length ? allowed.join(', ') : 'none'})`
    );
  }

  const now = new Date().toISOString();
  db.run(
    'UPDATE worktrees SET status = ?, error = ?, updated_at = ? WHERE id = ?',
    [newStatus, error ?? null, now, id],
  );

  // Log transition for session audit trail
  const errorSuffix = error ? ` (${error})` : '';
  console.error(`[forge] worktree ${id}: ${currentStatus} -> ${newStatus}${errorSuffix}`);

  return { previousStatus: currentStatus };
}

/**
 * Get the valid transitions from a given worktree status.
 * Useful for UI display and validation feedback.
 */
export function getValidTransitions(status: WorktreeStatus): WorktreeStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

/**
 * List all worktrees, optionally filtered by status.
 * Ordered by created_at DESC (newest first).
 */
export function listWorktrees(db: Database, status?: WorktreeStatus): WorktreeRow[] {
  if (status) {
    return db.query(
      'SELECT * FROM worktrees WHERE status = ? ORDER BY created_at DESC, rowid DESC',
    ).all(status) as WorktreeRow[];
  }
  return db.query(
    'SELECT * FROM worktrees ORDER BY created_at DESC, rowid DESC',
  ).all() as WorktreeRow[];
}

/**
 * Get all worktrees belonging to a work group.
 * Ordered by created_at ASC (oldest first, preserving creation order).
 */
export function getWorktreesByWorkGroup(db: Database, workGroupId: string): WorktreeRow[] {
  return db.query(
    'SELECT * FROM worktrees WHERE work_group_id = ? ORDER BY created_at ASC',
  ).all(workGroupId) as WorktreeRow[];
}

/**
 * Update a task's params JSON.
 * Used by the executor to store worktree path after creation.
 * Refreshes updatedAt as heartbeat.
 */
export function updateTaskParams(db: Database, id: string, params: Record<string, unknown>): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE tasks SET params = ?, updatedAt = ? WHERE id = ?',
    [JSON.stringify(params), now, id],
  );
}

/**
 * Update a worktree's PID (executor process managing it).
 * Refreshes updated_at.
 */
export function updateWorktreePid(db: Database, id: string, pid: number): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE worktrees SET pid = ?, updated_at = ? WHERE id = ?',
    [pid, now, id],
  );
}

/**
 * Link a worktree to a task (executor-dispatched).
 * Sets the task_id and refreshes updated_at.
 */
export function linkWorktreeTask(db: Database, id: string, taskId: string): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE worktrees SET task_id = ?, updated_at = ? WHERE id = ?',
    [taskId, now, id],
  );
}

/**
 * Link a worktree to an SDK session.
 * Sets the session_id and refreshes updated_at.
 */
export function linkWorktreeSession(db: Database, id: string, sessionId: string): void {
  const now = new Date().toISOString();
  db.run(
    'UPDATE worktrees SET session_id = ?, updated_at = ? WHERE id = ?',
    [sessionId, now, id],
  );
}

/**
 * Query sessions associated with a worktree, ordered by startedAt ASC.
 *
 * Association resolved via two paths:
 * 1. Direct link: worktrees.session_id matches sessions.id
 * 2. Task-based: sessions joined through tasks where tasks.cwd = worktree.worktree_path
 *
 * Returns deduplicated sessions sorted chronologically (oldest first) so the
 * watch command can tail them in order.
 */
export function querySessionsByWorktree(db: Database, worktreeId: string): SessionRow[] {
  return db.query(`
    SELECT DISTINCT s.* FROM sessions s
    WHERE s.id IN (
      -- Path 1: direct worktree.session_id link
      SELECT w.session_id FROM worktrees w
      WHERE w.id = ? AND w.session_id IS NOT NULL
      UNION
      -- Path 2: sessions linked through tasks running in the worktree path
      SELECT t.sessionId FROM tasks t
      JOIN worktrees w ON w.id = ? AND t.cwd = w.worktree_path
      WHERE t.sessionId IS NOT NULL
    )
    ORDER BY s.startedAt ASC
  `).all(worktreeId, worktreeId) as SessionRow[];
}

// ── Consolidation concurrency guard ──────────────────────────

/** Row shape for the consolidations table. */
export interface ConsolidationRow {
  work_group_id: string;
  pid: number;
  started_at: string;
}

/**
 * Check if a PID is alive (process exists).
 * Uses signal 0 which checks existence without sending a signal.
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
 * Acquire the consolidation lock for a work group.
 *
 * Returns `{ acquired: true }` if the lock was taken.
 * Returns `{ acquired: false, activePid }` if another live process holds the lock.
 * Clears stale locks (dead PID) before acquiring.
 */
export function acquireConsolidationLock(
  db: Database,
  workGroupId: string,
): { acquired: true } | { acquired: false; activePid: number } {
  const existing = db.query(
    'SELECT * FROM consolidations WHERE work_group_id = ?',
  ).get(workGroupId) as ConsolidationRow | null;

  if (existing) {
    if (isPidAlive(existing.pid)) {
      // Another live process is consolidating this work group
      return { acquired: false, activePid: existing.pid };
    }
    // Stale PID -- clear and proceed
    db.run('DELETE FROM consolidations WHERE work_group_id = ?', [workGroupId]);
  }

  const now = new Date().toISOString();
  db.run(
    'INSERT INTO consolidations (work_group_id, pid, started_at) VALUES (?, ?, ?)',
    [workGroupId, process.pid, now],
  );

  return { acquired: true };
}

/**
 * Release the consolidation lock for a work group.
 * Only deletes if the lock is held by the current process (safety check).
 */
export function releaseConsolidationLock(db: Database, workGroupId: string): void {
  db.run(
    'DELETE FROM consolidations WHERE work_group_id = ? AND pid = ?',
    [workGroupId, process.pid],
  );
}

/**
 * Release all consolidation locks held by the current process.
 * Called during Ctrl-C shutdown to clean up any in-progress consolidations.
 */
export function releaseAllConsolidationLocks(db: Database): void {
  db.run('DELETE FROM consolidations WHERE pid = ?', [process.pid]);
}
