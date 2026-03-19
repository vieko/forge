import { basename, dirname, join } from 'path';
import type { Database } from 'bun:sqlite';
import type { SpecEntry, SpecRun } from './types.js';
import type { ExecutorInfo, SessionInfo } from './tui-common.js';
import type { WorktreeRow, RunRow } from './db.js';
import { getDb, getActiveTasks, queryAllSessions } from './db.js';
import { isExecutorRunning } from './executor.js';

export async function getExecutorInfo(db: Database | null, cwd: string): Promise<ExecutorInfo> {
  const alive = await isExecutorRunning(cwd);
  if (!alive) {
    return { state: 'stopped', runningCount: 0, pendingCount: 0 };
  }
  if (!db) {
    return { state: 'idle', runningCount: 0, pendingCount: 0 };
  }
  const active = getActiveTasks(db);
  const runningCount = active.filter(t => t.status === 'running').length;
  const pendingCount = active.filter(t => t.status === 'pending').length;
  if (runningCount > 0 || pendingCount > 0) {
    return { state: 'running', runningCount, pendingCount };
  }
  return { state: 'idle', runningCount: 0, pendingCount: 0 };
}

export function deriveEventsPath(logPath?: string, sessionId?: string, cwd?: string): string {
  if (logPath) {
    return join(dirname(logPath), 'events.jsonl');
  }
  if (sessionId && cwd) {
    return join(cwd, '.forge', 'sessions', sessionId, 'events.jsonl');
  }
  return '';
}

export function getWorktreeSessionIds(db: Database, worktree: WorktreeRow): Set<string> {
  const ids = new Set<string>();
  if (worktree.session_id) {
    ids.add(worktree.session_id);
  }
  try {
    const rows = db.query(
      'SELECT DISTINCT sessionId FROM tasks WHERE cwd = ? AND sessionId IS NOT NULL',
    ).all(worktree.worktree_path) as { sessionId: string }[];
    for (const row of rows) {
      ids.add(row.sessionId);
    }
  } catch {
    // tasks table may not exist or query may fail
  }
  return ids;
}

export function loadSessionsFromDb(db: Database, cwd: string): SessionInfo[] {
  const rows = queryAllSessions(db, 200);
  const sessions: SessionInfo[] = [];

  for (const row of rows) {
    const isRunning = !row.status || row.status === 'running';
    const specName = row.specPath
      ? basename(row.specPath, '.md')
      : (row.commandType || 'run');
    const sessionId = row.id;
    const eventsPath = join(cwd, '.forge', 'sessions', sessionId, 'events.jsonl');

    sessions.push({
      sessionId,
      status: row.status || 'running',
      specName,
      specPath: row.specPath ?? undefined,
      model: row.model || '--',
      costUsd: row.costUsd ?? undefined,
      durationSeconds: undefined,
      startedAt: row.startedAt || new Date().toISOString(),
      eventsPath,
      isRunning,
      type: row.commandType ?? undefined,
    });
  }

  sessions.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return b.startedAt.localeCompare(a.startedAt);
  });

  return sessions;
}

export function enrichSessionsWithRuns(sessions: SessionInfo[], db: Database): void {
  try {
    const rows = db.query(
      'SELECT sessionId, durationSeconds, costUsd FROM runs WHERE sessionId IS NOT NULL',
    ).all() as { sessionId: string; durationSeconds: number; costUsd: number | null }[];

    const runMap = new Map<string, { durationSeconds: number; costUsd: number | null }>();
    for (const row of rows) {
      if (!runMap.has(row.sessionId)) {
        runMap.set(row.sessionId, row);
      }
    }

    for (const session of sessions) {
      const run = runMap.get(session.sessionId);
      if (run) {
        if (session.durationSeconds === undefined) {
          session.durationSeconds = run.durationSeconds;
        }
        if (session.costUsd === undefined && run.costUsd !== null) {
          session.costUsd = run.costUsd;
        }
      }
    }
  } catch {
    // Best effort — runs table may not be populated
  }
}

export function loadSessionFromResult(run: SpecRun, cwd: string, entry: SpecEntry): SessionInfo | null {
  try {
    const db = getDb(cwd);
    if (!db) return null;

    const row = db.query('SELECT * FROM runs WHERE id = ?').get(run.runId) as RunRow | null;
    if (!row) return null;

    return {
      sessionId: row.sessionId || run.runId,
      status: row.status,
      specName: basename(entry.spec, '.md'),
      specPath: row.specPath ?? undefined,
      model: row.model || '--',
      costUsd: row.costUsd ?? undefined,
      durationSeconds: row.durationSeconds,
      startedAt: row.createdAt,
      eventsPath: deriveEventsPath(undefined, row.sessionId ?? undefined, cwd),
      isRunning: false,
      type: row.type ?? undefined,
    };
  } catch {
    return null;
  }
}
