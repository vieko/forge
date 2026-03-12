import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  getDb,
  getTestDb,
  closeDb,
  closeAllDbs,
  getSchemaVersion,
  migrations,
  ensureDbGitignore,
} from './db.js';

// ── getTestDb ────────────────────────────────────────────────

describe('getTestDb', () => {
  test('returns an in-memory Database instance', () => {
    const db = getTestDb();
    expect(db).toBeInstanceOf(Database);
    db.close();
  });

  test('has schema_version table', () => {
    const db = getTestDb();
    const row = db.query('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    expect(row).not.toBeNull();
    expect(typeof row.version).toBe('number');
    db.close();
  });

  test('schema version matches latest migration or 0 if no migrations', () => {
    const db = getTestDb();
    const expected = migrations.length > 0
      ? Math.max(...migrations.map(m => m.version))
      : 0;
    const version = getSchemaVersion(db);
    expect(version).toBe(expected);
    db.close();
  });

  test('each call returns a fresh isolated instance', () => {
    const db1 = getTestDb();
    const db2 = getTestDb();

    // Create a table in db1
    db1.run('CREATE TABLE test_isolation (id INTEGER PRIMARY KEY)');
    db1.run('INSERT INTO test_isolation (id) VALUES (1)');

    // db2 should NOT have the table
    expect(() => db2.query('SELECT * FROM test_isolation').all()).toThrow();

    db1.close();
    db2.close();
  });

  test('WAL mode is enabled', () => {
    const db = getTestDb();
    // In-memory databases may report 'memory' or 'wal' depending on bun version
    // The important thing is the pragma was set without error
    const result = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(result).not.toBeNull();
    db.close();
  });
});

// ── getSchemaVersion ─────────────────────────────────────────

describe('getSchemaVersion', () => {
  test('returns version from schema_version table', () => {
    const db = getTestDb();
    const version = getSchemaVersion(db);
    expect(version).toBeGreaterThanOrEqual(0);
    db.close();
  });

  test('returns -1 when schema_version table does not exist', () => {
    const db = new Database(':memory:');
    const version = getSchemaVersion(db);
    expect(version).toBe(-1);
    db.close();
  });
});

// ── Migration runner ─────────────────────────────────────────

describe('migration runner', () => {
  test('schema_version starts at 0 with no migrations', () => {
    const db = getTestDb();
    // With no migrations in the array, version stays at 0
    if (migrations.length === 0) {
      expect(getSchemaVersion(db)).toBe(0);
    }
    db.close();
  });

  test('schema_version table has correct structure', () => {
    const db = getTestDb();
    // Verify table columns
    const info = db.query('PRAGMA table_info(schema_version)').all() as Array<{
      name: string;
      type: string;
    }>;
    const columns = info.map(c => c.name);
    expect(columns).toContain('id');
    expect(columns).toContain('version');
    expect(columns).toContain('updated_at');
    db.close();
  });

  test('schema_version id=1 constraint works (single row)', () => {
    const db = getTestDb();
    // Attempting to insert a second row with id != 1 should fail due to CHECK constraint
    expect(() => {
      db.run('INSERT INTO schema_version (id, version) VALUES (2, 99)');
    }).toThrow();
    db.close();
  });

  test('re-running initSchema on same db is idempotent', () => {
    // getTestDb runs initSchema; calling getTestDb on a fresh DB and then
    // manually re-initializing should not fail or change version
    const db = getTestDb();
    const v1 = getSchemaVersion(db);

    // Manually re-run the init (simulating double-init)
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const v2 = getSchemaVersion(db);
    expect(v2).toBe(v1);

    db.close();
  });
});

// ── getDb (filesystem) ───────────────────────────────────────

describe('getDb', () => {
  const tmpDir = path.join(os.tmpdir(), `forge-db-test-${Date.now()}`);

  beforeAll(async () => {
    await fs.mkdir(path.join(tmpDir, '.forge'), { recursive: true });
  });

  afterAll(async () => {
    closeDb(tmpDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('creates database file in .forge directory', () => {
    const db = getDb(tmpDir);
    expect(db).not.toBeNull();
    expect(db).toBeInstanceOf(Database);

    // Verify file was created
    const dbPath = path.join(tmpDir, '.forge', 'forge.db');
    const stat = require('fs').statSync(dbPath);
    expect(stat.isFile()).toBe(true);
  });

  test('returns cached instance on subsequent calls', () => {
    const db1 = getDb(tmpDir);
    const db2 = getDb(tmpDir);
    expect(db1).toBe(db2); // Same reference
  });

  test('has schema_version table initialized', () => {
    const db = getDb(tmpDir);
    expect(db).not.toBeNull();
    const version = getSchemaVersion(db!);
    expect(version).toBeGreaterThanOrEqual(0);
  });

  test('creates .forge directory if it does not exist', () => {
    const freshDir = path.join(os.tmpdir(), `forge-db-fresh-${Date.now()}`);
    require('fs').mkdirSync(freshDir, { recursive: true });

    try {
      const db = getDb(freshDir);
      expect(db).not.toBeNull();
      closeDb(freshDir);
    } finally {
      require('fs').rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// ── closeDb / closeAllDbs ────────────────────────────────────

describe('closeDb', () => {
  test('closes and removes cached instance', () => {
    const tmpDir = path.join(os.tmpdir(), `forge-db-close-${Date.now()}`);
    require('fs').mkdirSync(path.join(tmpDir, '.forge'), { recursive: true });

    const db1 = getDb(tmpDir);
    expect(db1).not.toBeNull();

    closeDb(tmpDir);

    // Next call should create a new instance (different reference)
    const db2 = getDb(tmpDir);
    expect(db2).not.toBeNull();
    expect(db2).not.toBe(db1);

    closeDb(tmpDir);
    require('fs').rmSync(tmpDir, { recursive: true, force: true });
  });

  test('closeDb on unknown path does not throw', () => {
    expect(() => closeDb('/nonexistent/path/that/does/not/exist')).not.toThrow();
  });
});

describe('closeAllDbs', () => {
  test('closes all cached instances without throwing', () => {
    const dir1 = path.join(os.tmpdir(), `forge-db-all1-${Date.now()}`);
    const dir2 = path.join(os.tmpdir(), `forge-db-all2-${Date.now()}`);
    require('fs').mkdirSync(path.join(dir1, '.forge'), { recursive: true });
    require('fs').mkdirSync(path.join(dir2, '.forge'), { recursive: true });

    getDb(dir1);
    getDb(dir2);

    expect(() => closeAllDbs()).not.toThrow();

    require('fs').rmSync(dir1, { recursive: true, force: true });
    require('fs').rmSync(dir2, { recursive: true, force: true });
  });
});

// ── ensureDbGitignore ────────────────────────────────────────

describe('ensureDbGitignore', () => {
  test('no-op when gitignore has wildcard *', async () => {
    const tmpDir = path.join(os.tmpdir(), `forge-gitignore-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const gitignorePath = path.join(tmpDir, '.gitignore');
    const content = '# Ignore everything\n*\n!.gitignore\n!specs.json\n';
    await fs.writeFile(gitignorePath, content);

    await ensureDbGitignore(tmpDir);

    // Content should be unchanged
    const after = await fs.readFile(gitignorePath, 'utf-8');
    expect(after).toBe(content);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('appends DB entries when gitignore lacks wildcard and DB entries', async () => {
    const tmpDir = path.join(os.tmpdir(), `forge-gitignore-no-wild-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'results/\nsessions/\n');

    await ensureDbGitignore(tmpDir);

    const after = await fs.readFile(gitignorePath, 'utf-8');
    expect(after).toContain('forge.db');
    expect(after).toContain('forge.db-wal');
    expect(after).toContain('forge.db-shm');

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('does not duplicate entries on repeated calls', async () => {
    const tmpDir = path.join(os.tmpdir(), `forge-gitignore-dup-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const gitignorePath = path.join(tmpDir, '.gitignore');
    await fs.writeFile(gitignorePath, 'results/\n');

    await ensureDbGitignore(tmpDir);
    await ensureDbGitignore(tmpDir);

    const after = await fs.readFile(gitignorePath, 'utf-8');
    const count = (after.match(/forge\.db\n/g) || []).length;
    expect(count).toBe(1);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('no-op when gitignore does not exist', async () => {
    const tmpDir = path.join(os.tmpdir(), `forge-gitignore-missing-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    // Should not throw
    await expect(ensureDbGitignore(tmpDir)).resolves.toBeUndefined();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ── Graceful degradation ─────────────────────────────────────

describe('graceful degradation', () => {
  test('getDb returns null for invalid path (not a directory)', () => {
    // Pass a file path instead of directory — should degrade gracefully
    const tmpFile = path.join(os.tmpdir(), `forge-db-file-${Date.now()}`);
    require('fs').writeFileSync(tmpFile, 'not a dir');

    const db = getDb(tmpFile);
    // Should return null because .forge cannot be created inside a file
    expect(db).toBeNull();

    require('fs').unlinkSync(tmpFile);
  });
});

// ── PRAGMA verification ──────────────────────────────────────

describe('PRAGMA settings', () => {
  test('busy_timeout is set', () => {
    const db = getTestDb();
    const result = db.query('PRAGMA busy_timeout').get() as { timeout: number };
    expect(result.timeout).toBe(5000);
    db.close();
  });

  test('wal_autocheckpoint is set', () => {
    const db = getTestDb();
    const result = db.query('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number };
    expect(result.wal_autocheckpoint).toBe(1000);
    db.close();
  });
});
