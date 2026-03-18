import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  getTestDb,
  getSchemaVersion,
  insertSession,
  updateSession,
  querySessionsBySpec,
  querySessionsByPipeline,
  querySessionsByCommandType,
  queryAllSessions,
} from './db.js';

// ── Sessions table migration ─────────────────────────────────

describe('sessions table migration', () => {
  test('sessions table exists after migration', () => {
    const db = getTestDb();
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
    ).all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);
    expect(tables[0].name).toBe('sessions');
    db.close();
  });

  test('sessions table has correct columns', () => {
    const db = getTestDb();
    const info = db.query('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
      type: string;
    }>;
    const columns = info.map(c => c.name);
    expect(columns).toContain('id');
    expect(columns).toContain('specPath');
    expect(columns).toContain('pipelineId');
    expect(columns).toContain('commandType');
    expect(columns).toContain('model');
    expect(columns).toContain('status');
    expect(columns).toContain('costUsd');
    expect(columns).toContain('startedAt');
    expect(columns).toContain('endedAt');
    db.close();
  });

  test('schema version is at least 4 (sessions migration)', () => {
    const db = getTestDb();
    const version = getSchemaVersion(db);
    expect(version).toBeGreaterThanOrEqual(4);
    db.close();
  });

  test('sessions indexes exist', () => {
    const db = getTestDb();
    const indexes = db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'",
    ).all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_sessions_specPath');
    expect(names).toContain('idx_sessions_pipelineId');
    expect(names).toContain('idx_sessions_commandType');
    expect(names).toContain('idx_sessions_startedAt');
    db.close();
  });
});

// ── insertSession ────────────────────────────────────────────

describe('insertSession', () => {
  let db: Database;

  beforeEach(() => {
    db = getTestDb();
  });

  test('inserts a session with all fields', () => {
    insertSession(db, {
      id: 'sess-001',
      specPath: 'specs/auth.md',
      pipelineId: 'pipe-001',
      commandType: 'run',
      model: 'opus',
      startedAt: '2026-03-12T10:00:00.000Z',
    });

    const row = db.query('SELECT * FROM sessions WHERE id = ?').get('sess-001') as Record<string, unknown>;
    expect(row).not.toBeNull();
    expect(row.id).toBe('sess-001');
    expect(row.specPath).toBe('specs/auth.md');
    expect(row.pipelineId).toBe('pipe-001');
    expect(row.commandType).toBe('run');
    expect(row.model).toBe('opus');
    expect(row.status).toBe('running');
    expect(row.startedAt).toBe('2026-03-12T10:00:00.000Z');
    expect(row.costUsd).toBeNull();
    expect(row.endedAt).toBeNull();
    db.close();
  });

  test('inserts a session with minimal fields (nullable columns)', () => {
    insertSession(db, {
      id: 'sess-002',
      startedAt: '2026-03-12T10:00:00.000Z',
    });

    const row = db.query('SELECT * FROM sessions WHERE id = ?').get('sess-002') as Record<string, unknown>;
    expect(row).not.toBeNull();
    expect(row.id).toBe('sess-002');
    expect(row.specPath).toBeNull();
    expect(row.pipelineId).toBeNull();
    expect(row.commandType).toBeNull();
    expect(row.model).toBeNull();
    expect(row.status).toBe('running');
    db.close();
  });

  test('INSERT OR IGNORE skips duplicate session IDs', () => {
    insertSession(db, {
      id: 'sess-dup',
      model: 'opus',
      startedAt: '2026-03-12T10:00:00.000Z',
    });

    // Insert again with different data — should be silently ignored
    insertSession(db, {
      id: 'sess-dup',
      model: 'sonnet',
      startedAt: '2026-03-12T11:00:00.000Z',
    });

    const row = db.query('SELECT * FROM sessions WHERE id = ?').get('sess-dup') as Record<string, unknown>;
    expect(row.model).toBe('opus'); // Original value preserved
    db.close();
  });
});

// ── updateSession ────────────────────────────────────────────

describe('updateSession', () => {
  let db: Database;

  beforeEach(() => {
    db = getTestDb();
    insertSession(db, {
      id: 'sess-upd',
      specPath: 'specs/test.md',
      commandType: 'run',
      model: 'opus',
      startedAt: '2026-03-12T10:00:00.000Z',
    });
  });

  test('updates status, costUsd, and endedAt on success', () => {
    updateSession(db, 'sess-upd', {
      status: 'success',
      costUsd: 1.23,
      endedAt: '2026-03-12T10:05:00.000Z',
    });

    const row = db.query('SELECT * FROM sessions WHERE id = ?').get('sess-upd') as Record<string, unknown>;
    expect(row.status).toBe('success');
    expect(row.costUsd).toBe(1.23);
    expect(row.endedAt).toBe('2026-03-12T10:05:00.000Z');
    db.close();
  });

  test('updates status on error without cost', () => {
    updateSession(db, 'sess-upd', {
      status: 'error_execution',
      endedAt: '2026-03-12T10:05:00.000Z',
    });

    const row = db.query('SELECT * FROM sessions WHERE id = ?').get('sess-upd') as Record<string, unknown>;
    expect(row.status).toBe('error_execution');
    expect(row.costUsd).toBeNull();
    expect(row.endedAt).toBe('2026-03-12T10:05:00.000Z');
    db.close();
  });

  test('update on non-existent session is a no-op', () => {
    // Should not throw
    updateSession(db, 'nonexistent', {
      status: 'success',
      endedAt: '2026-03-12T10:05:00.000Z',
    });

    const row = db.query('SELECT * FROM sessions WHERE id = ?').get('nonexistent');
    expect(row).toBeNull();
    db.close();
  });
});

// ── querySessionsBySpec ──────────────────────────────────────

describe('querySessionsBySpec', () => {
  let db: Database;

  beforeEach(() => {
    db = getTestDb();
    insertSession(db, { id: 's1', specPath: 'specs/auth.md', model: 'opus', startedAt: '2026-03-12T10:00:00Z' });
    insertSession(db, { id: 's2', specPath: 'specs/auth.md', model: 'sonnet', startedAt: '2026-03-12T11:00:00Z' });
    insertSession(db, { id: 's3', specPath: 'specs/db.md', model: 'opus', startedAt: '2026-03-12T12:00:00Z' });
    updateSession(db, 's1', { status: 'success', costUsd: 0.50, endedAt: '2026-03-12T10:05:00Z' });
    updateSession(db, 's2', { status: 'error_execution', endedAt: '2026-03-12T11:05:00Z' });
  });

  test('returns sessions matching specPath ordered by startedAt DESC', () => {
    const rows = querySessionsBySpec(db, 'specs/auth.md');
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe('s2'); // Newer first
    expect(rows[1].id).toBe('s1');
    db.close();
  });

  test('returns empty array for non-matching specPath', () => {
    const rows = querySessionsBySpec(db, 'specs/nonexistent.md');
    expect(rows.length).toBe(0);
    db.close();
  });
});

// ── querySessionsByPipeline ──────────────────────────────────

describe('querySessionsByPipeline', () => {
  let db: Database;

  beforeEach(() => {
    db = getTestDb();
    insertSession(db, { id: 'p1', pipelineId: 'pipe-A', commandType: 'run', startedAt: '2026-03-12T10:00:00Z' });
    insertSession(db, { id: 'p2', pipelineId: 'pipe-A', commandType: 'audit', startedAt: '2026-03-12T11:00:00Z' });
    insertSession(db, { id: 'p3', pipelineId: 'pipe-B', commandType: 'run', startedAt: '2026-03-12T12:00:00Z' });
  });

  test('returns sessions matching pipelineId ordered by startedAt DESC', () => {
    const rows = querySessionsByPipeline(db, 'pipe-A');
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe('p2');
    expect(rows[1].id).toBe('p1');
    db.close();
  });

  test('returns empty array for non-matching pipelineId', () => {
    const rows = querySessionsByPipeline(db, 'pipe-Z');
    expect(rows.length).toBe(0);
    db.close();
  });
});

// ── querySessionsByCommandType ───────────────────────────────

describe('querySessionsByCommandType', () => {
  let db: Database;

  beforeEach(() => {
    db = getTestDb();
    insertSession(db, { id: 'c1', commandType: 'run', startedAt: '2026-03-12T10:00:00Z' });
    insertSession(db, { id: 'c2', commandType: 'audit', startedAt: '2026-03-12T11:00:00Z' });
    insertSession(db, { id: 'c3', commandType: 'run', startedAt: '2026-03-12T12:00:00Z' });
  });

  test('returns sessions matching commandType', () => {
    const rows = querySessionsByCommandType(db, 'run');
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe('c3'); // Newer first
    expect(rows[1].id).toBe('c1');
    db.close();
  });

  test('returns empty for non-matching commandType', () => {
    const rows = querySessionsByCommandType(db, 'verify');
    expect(rows.length).toBe(0);
    db.close();
  });
});

// ── queryAllSessions ─────────────────────────────────────────

describe('queryAllSessions', () => {
  let db: Database;

  beforeEach(() => {
    db = getTestDb();
    insertSession(db, { id: 'a1', startedAt: '2026-03-12T10:00:00Z' });
    insertSession(db, { id: 'a2', startedAt: '2026-03-12T11:00:00Z' });
    insertSession(db, { id: 'a3', startedAt: '2026-03-12T12:00:00Z' });
  });

  test('returns all sessions ordered by startedAt DESC', () => {
    const rows = queryAllSessions(db);
    expect(rows.length).toBe(3);
    expect(rows[0].id).toBe('a3');
    expect(rows[1].id).toBe('a2');
    expect(rows[2].id).toBe('a1');
    db.close();
  });

  test('respects limit parameter', () => {
    const rows = queryAllSessions(db, 2);
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe('a3');
    expect(rows[1].id).toBe('a2');
    db.close();
  });

  test('returns empty array when no sessions', () => {
    const emptyDb = getTestDb();
    const rows = queryAllSessions(emptyDb);
    expect(rows.length).toBe(0);
    emptyDb.close();
  });
});

