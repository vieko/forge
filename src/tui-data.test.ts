import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getDb, insertRun, insertSession, insertTask, updateSession } from './db.js';
import {
  deriveEventsPath,
  enrichSessionsWithRuns,
  getWorktreeSessionIds,
  loadSessionFromResult,
  loadSessionsFromDb,
} from './tui-data.js';
import { nextTab } from './tui-app.js';
import type { SpecEntry, SpecRun } from './types.js';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tui-data-'));
  const dir = await fs.realpath(raw);
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs = [];
});

function makeRun(overrides: Partial<SpecRun> = {}): SpecRun {
  return {
    runId: 'run-1',
    timestamp: '2026-03-01T00:00:00Z',
    resultPath: '.forge/results/2026-03-01T00:00:00Z',
    status: 'passed',
    costUsd: 1.25,
    durationSeconds: 90,
    numTurns: 12,
    verifyAttempts: 1,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<SpecEntry> = {}): SpecEntry {
  return {
    spec: 'specs/auth/login.md',
    status: 'passed',
    runs: [],
    source: 'file',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

describe('tui-data', () => {
  test('deriveEventsPath prefers logPath when present', () => {
    expect(deriveEventsPath('/repo/.forge/sessions/abc/stream.log', 'ignored', '/tmp')).toBe(
      path.join('/repo/.forge/sessions/abc', 'events.jsonl'),
    );
  });

  test('deriveEventsPath falls back to cwd + sessionId', () => {
    expect(deriveEventsPath(undefined, 'sess-123', '/repo')).toBe(
      path.join('/repo', '.forge', 'sessions', 'sess-123', 'events.jsonl'),
    );
  });

  test('loadSessionsFromDb sorts running sessions first, then newest first', async () => {
    const dir = await makeTmpDir();
    const db = getDb(dir)!;

    insertSession(db, {
      id: 'sess-old-success',
      startedAt: '2026-03-01T00:00:00Z',
      commandType: 'run',
      specPath: 'specs/old.md',
      model: 'sonnet',
    });
    updateSession(db, 'sess-old-success', {
      status: 'success',
      endedAt: '2026-03-01T00:01:00Z',
    });

    insertSession(db, {
      id: 'sess-running',
      startedAt: '2026-03-02T00:00:00Z',
      commandType: 'audit',
      specPath: 'specs/live.md',
      model: 'opus',
    });

    insertSession(db, {
      id: 'sess-new-success',
      startedAt: '2026-03-03T00:00:00Z',
      commandType: 'run',
      specPath: 'specs/new.md',
      model: 'sonnet',
    });
    updateSession(db, 'sess-new-success', {
      status: 'success',
      endedAt: '2026-03-03T00:01:00Z',
    });

    const sessions = loadSessionsFromDb(db, dir);
    expect(sessions.map(s => s.sessionId)).toEqual([
      'sess-running',
      'sess-new-success',
      'sess-old-success',
    ]);
    expect(sessions[0]?.specName).toBe('live');
    expect(sessions[0]?.type).toBe('audit');
  });

  test('enrichSessionsWithRuns fills duration and missing cost from runs table', async () => {
    const dir = await makeTmpDir();
    const db = getDb(dir)!;

    const sessions = [
      {
        sessionId: 'sess-1',
        status: 'success' as const,
        specName: 'auth',
        model: 'sonnet',
        startedAt: '2026-03-01T00:00:00Z',
        eventsPath: '/tmp/events.jsonl',
        isRunning: false,
        costUsd: undefined,
        durationSeconds: undefined,
      },
    ];

    insertRun(db, {
      id: 'run-1',
      sessionId: 'sess-1',
      createdAt: '2026-03-01T00:00:00Z',
      model: 'sonnet',
      status: 'success',
      durationSeconds: 123,
      prompt: 'test',
      cwd: dir,
      specPath: 'specs/auth.md',
      costUsd: 4.56,
      numTurns: 8,
      toolCalls: 3,
      batchId: null,
      type: 'run',
      error: null,
    });

    enrichSessionsWithRuns(sessions, db);
    expect(sessions[0]?.durationSeconds).toBe(123);
    expect(sessions[0]?.costUsd).toBe(4.56);
  });

  test('getWorktreeSessionIds merges direct and task-linked session ids', async () => {
    const dir = await makeTmpDir();
    const db = getDb(dir)!;
    const worktreePath = path.join(dir, 'worktrees', 'feature-auth');

    insertTask(db, {
      id: 'task-1',
      command: 'run',
      description: 'desc',
      specPath: 'specs/auth.md',
      status: 'running',
      sessionId: 'sess-task-a',
      cwd: worktreePath,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      stdout: '[]',
      stderr: '[]',
    });
    insertTask(db, {
      id: 'task-2',
      command: 'run',
      description: 'desc',
      specPath: 'specs/auth.md',
      status: 'running',
      sessionId: 'sess-task-b',
      cwd: worktreePath,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      stdout: '[]',
      stderr: '[]',
    });

    const ids = getWorktreeSessionIds(db, {
      id: 'wt-1',
      work_group_id: null,
      spec_path: 'specs/auth.md',
      spec_paths: '["specs/auth.md"]',
      branch: 'feature/auth',
      worktree_path: worktreePath,
      status: 'running',
      session_id: 'sess-direct',
      task_id: null,
      error: null,
      created_at: '2026-03-01T00:00:00Z',
      updated_at: '2026-03-01T00:00:00Z',
    });

    expect([...ids].sort()).toEqual(['sess-direct', 'sess-task-a', 'sess-task-b']);
  });

  test('loadSessionFromResult resolves run metadata into session info', async () => {
    const dir = await makeTmpDir();
    const db = getDb(dir)!;
    insertRun(db, {
      id: 'run-abc',
      sessionId: 'sess-abc',
      createdAt: '2026-03-02T12:00:00Z',
      model: 'opus',
      status: 'success',
      durationSeconds: 77,
      prompt: 'test',
      cwd: dir,
      specPath: 'specs/auth/login.md',
      costUsd: 2.34,
      numTurns: 11,
      toolCalls: 5,
      batchId: null,
      type: 'audit',
      error: null,
    });

    const session = loadSessionFromResult(
      makeRun({ runId: 'run-abc' }),
      dir,
      makeEntry({ spec: 'specs/auth/login.md' }),
    );

    expect(session).not.toBeNull();
    expect(session?.sessionId).toBe('sess-abc');
    expect(session?.specName).toBe('login');
    expect(session?.model).toBe('opus');
    expect(session?.type).toBe('audit');
    expect(session?.eventsPath).toBe(path.join(dir, '.forge', 'sessions', 'sess-abc', 'events.jsonl'));
  });
});

describe('tui-app', () => {
  test('nextTab cycles through all tabs', () => {
    expect(nextTab('sessions')).toBe('specs');
    expect(nextTab('specs')).toBe('pipeline');
    expect(nextTab('pipeline')).toBe('worktrees');
    expect(nextTab('worktrees')).toBe('sessions');
  });
});
