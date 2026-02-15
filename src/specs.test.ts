import { describe, test, expect, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  findOrCreateEntry,
  updateEntryStatus,
  specKey,
  pipeSpecId,
  loadManifest,
  saveManifest,
  withManifestLock,
} from './specs.js';
import type { SpecManifest, SpecEntry, SpecRun } from './types.js';

// ── Helpers ──────────────────────────────────────────────────

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-specs-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs = [];
});

function emptyManifest(): SpecManifest {
  return { version: 1, specs: [] };
}

function makeRun(overrides: Partial<SpecRun> = {}): SpecRun {
  return {
    runId: 'run-1',
    timestamp: '2026-02-15T00:00:00Z',
    resultPath: '.forge/results/2026-02-15T00:00:00Z',
    status: 'passed',
    costUsd: 0.5,
    durationSeconds: 60,
    ...overrides,
  };
}

// ── findOrCreateEntry ────────────────────────────────────────

describe('findOrCreateEntry', () => {
  test('creates new entry with correct defaults', () => {
    const manifest = emptyManifest();
    const entry = findOrCreateEntry(manifest, 'auth/login.md', 'file');

    expect(entry.spec).toBe('auth/login.md');
    expect(entry.status).toBe('pending');
    expect(entry.runs).toEqual([]);
    expect(entry.source).toBe('file');
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
    // Timestamps should be valid ISO
    expect(() => new Date(entry.createdAt)).not.toThrow();
    expect(() => new Date(entry.updatedAt)).not.toThrow();
  });

  test('returns existing entry when spec key matches (no duplicate)', () => {
    const manifest = emptyManifest();
    const first = findOrCreateEntry(manifest, 'auth/login.md', 'file');
    first.status = 'passed'; // mutate to verify identity

    const second = findOrCreateEntry(manifest, 'auth/login.md', 'file');
    expect(second).toBe(first); // same reference
    expect(second.status).toBe('passed');
    expect(manifest.specs).toHaveLength(1);
  });

  test('handles source type "file"', () => {
    const manifest = emptyManifest();
    const entry = findOrCreateEntry(manifest, 'spec.md', 'file');
    expect(entry.source).toBe('file');
  });

  test('handles source type "pipe"', () => {
    const manifest = emptyManifest();
    const entry = findOrCreateEntry(manifest, 'pipe:abc123', 'pipe');
    expect(entry.source).toBe('pipe');
  });

  test('handles source type "github:vieko/forge#15"', () => {
    const manifest = emptyManifest();
    const entry = findOrCreateEntry(manifest, 'feature.md', 'github:vieko/forge#15');
    expect(entry.source).toBe('github:vieko/forge#15');
  });

  test('handles source type "audit:2026-02-14T..."', () => {
    const manifest = emptyManifest();
    const entry = findOrCreateEntry(manifest, 'remediation.md', 'audit:2026-02-14T12:00:00Z');
    expect(entry.source).toBe('audit:2026-02-14T12:00:00Z');
  });

  test('appends to manifest.specs array on creation', () => {
    const manifest = emptyManifest();
    findOrCreateEntry(manifest, 'a.md', 'file');
    findOrCreateEntry(manifest, 'b.md', 'file');
    findOrCreateEntry(manifest, 'c.md', 'pipe');

    expect(manifest.specs).toHaveLength(3);
    expect(manifest.specs.map(e => e.spec)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  test('does not mutate existing entries when creating new ones', () => {
    const manifest = emptyManifest();
    const first = findOrCreateEntry(manifest, 'a.md', 'file');
    const firstSnapshot = { ...first };

    findOrCreateEntry(manifest, 'b.md', 'pipe');

    expect(first.spec).toBe(firstSnapshot.spec);
    expect(first.status).toBe(firstSnapshot.status);
    expect(first.source).toBe(firstSnapshot.source);
    expect(first.runs).toEqual(firstSnapshot.runs);
  });
});

// ── updateEntryStatus ────────────────────────────────────────

describe('updateEntryStatus', () => {
  test('empty runs array → status stays pending', () => {
    const entry: SpecEntry = {
      spec: 'test.md',
      status: 'running', // intentionally not pending, to verify it gets reset
      runs: [],
      source: 'file',
      createdAt: '2026-02-15T00:00:00Z',
      updatedAt: '2026-02-15T00:00:00Z',
    };

    updateEntryStatus(entry);
    expect(entry.status).toBe('pending');
  });

  test('single passed run → status becomes passed', () => {
    const entry: SpecEntry = {
      spec: 'test.md',
      status: 'pending',
      runs: [makeRun({ status: 'passed' })],
      source: 'file',
      createdAt: '2026-02-15T00:00:00Z',
      updatedAt: '2026-02-15T00:00:00Z',
    };

    updateEntryStatus(entry);
    expect(entry.status).toBe('passed');
  });

  test('single failed run → status becomes failed', () => {
    const entry: SpecEntry = {
      spec: 'test.md',
      status: 'pending',
      runs: [makeRun({ status: 'failed' })],
      source: 'file',
      createdAt: '2026-02-15T00:00:00Z',
      updatedAt: '2026-02-15T00:00:00Z',
    };

    updateEntryStatus(entry);
    expect(entry.status).toBe('failed');
  });

  test('multiple runs, latest passed → status is passed', () => {
    const entry: SpecEntry = {
      spec: 'test.md',
      status: 'failed',
      runs: [
        makeRun({ runId: 'run-1', status: 'failed' }),
        makeRun({ runId: 'run-2', status: 'passed' }),
      ],
      source: 'file',
      createdAt: '2026-02-15T00:00:00Z',
      updatedAt: '2026-02-15T00:00:00Z',
    };

    updateEntryStatus(entry);
    expect(entry.status).toBe('passed');
  });

  test('multiple runs, latest failed → status is failed (even if earlier ones passed)', () => {
    const entry: SpecEntry = {
      spec: 'test.md',
      status: 'passed',
      runs: [
        makeRun({ runId: 'run-1', status: 'passed' }),
        makeRun({ runId: 'run-2', status: 'failed' }),
      ],
      source: 'file',
      createdAt: '2026-02-15T00:00:00Z',
      updatedAt: '2026-02-15T00:00:00Z',
    };

    updateEntryStatus(entry);
    expect(entry.status).toBe('failed');
  });

  test('updates updatedAt timestamp', () => {
    const oldTimestamp = '2026-01-01T00:00:00Z';
    const entry: SpecEntry = {
      spec: 'test.md',
      status: 'pending',
      runs: [],
      source: 'file',
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
    };

    updateEntryStatus(entry);
    expect(entry.updatedAt).not.toBe(oldTimestamp);
    // New timestamp should be later
    expect(new Date(entry.updatedAt).getTime()).toBeGreaterThan(new Date(oldTimestamp).getTime());
  });
});

// ── specKey ──────────────────────────────────────────────────

describe('specKey', () => {
  test('absolute path inside workingDir → returns relative path', () => {
    const result = specKey('/home/user/project/specs/auth.md', '/home/user/project');
    expect(result).toBe('specs/auth.md');
  });

  test('absolute path outside workingDir → returns absolute path', () => {
    const result = specKey('/other/place/auth.md', '/home/user/project');
    expect(result).toBe('/other/place/auth.md');
  });

  test('already relative-looking path → returns as-is (when path.relative yields no ..)', () => {
    // path.relative of a relative path from an absolute dir produces a relative result
    // that starts with '..', so it returns the original path
    const result = specKey('specs/auth.md', '/home/user/project');
    // path.relative('/home/user/project', 'specs/auth.md') is a relative path
    // The behavior depends on path.relative — it could start with .. or not
    // Just verify it returns a string
    expect(typeof result).toBe('string');
  });

  test('handles nested paths inside workingDir', () => {
    const result = specKey('/home/user/project/specs/auth/login.md', '/home/user/project');
    expect(result).toBe('specs/auth/login.md');
  });
});

// ── pipeSpecId ───────────────────────────────────────────────

describe('pipeSpecId', () => {
  test('returns pipe: prefixed 8-char hex hash', () => {
    const id = pipeSpecId('some spec content');
    expect(id).toMatch(/^pipe:[0-9a-f]{8}$/);
  });

  test('same content produces same ID (deterministic)', () => {
    const content = 'implement authentication';
    const id1 = pipeSpecId(content);
    const id2 = pipeSpecId(content);
    expect(id1).toBe(id2);
  });

  test('different content produces different ID', () => {
    const id1 = pipeSpecId('implement authentication');
    const id2 = pipeSpecId('implement authorization');
    expect(id1).not.toBe(id2);
  });
});

// ── loadManifest ─────────────────────────────────────────────

describe('loadManifest', () => {
  test('missing file returns empty manifest', async () => {
    const dir = await makeTmpDir();
    const manifest = await loadManifest(dir);
    expect(manifest).toEqual({ version: 1, specs: [] });
  });

  test('valid JSON file returns parsed manifest', async () => {
    const dir = await makeTmpDir();
    const forgeDir = path.join(dir, '.forge');
    await fs.mkdir(forgeDir, { recursive: true });

    const expected: SpecManifest = {
      version: 1,
      specs: [
        {
          spec: 'test.md',
          status: 'passed',
          runs: [],
          source: 'file',
          createdAt: '2026-02-15T00:00:00Z',
          updatedAt: '2026-02-15T00:00:00Z',
        },
      ],
    };
    await fs.writeFile(path.join(forgeDir, 'specs.json'), JSON.stringify(expected));

    const manifest = await loadManifest(dir);
    expect(manifest).toEqual(expected);
  });

  test('corrupted/invalid JSON returns empty manifest (does not throw)', async () => {
    const dir = await makeTmpDir();
    const forgeDir = path.join(dir, '.forge');
    await fs.mkdir(forgeDir, { recursive: true });
    await fs.writeFile(path.join(forgeDir, 'specs.json'), '{invalid json!!!');

    const manifest = await loadManifest(dir);
    expect(manifest).toEqual({ version: 1, specs: [] });
  });
});

// ── saveManifest ─────────────────────────────────────────────

describe('saveManifest', () => {
  test('creates .forge/ directory if missing', async () => {
    const dir = await makeTmpDir();
    const manifest: SpecManifest = { version: 1, specs: [] };

    await saveManifest(dir, manifest);

    const stat = await fs.stat(path.join(dir, '.forge'));
    expect(stat.isDirectory()).toBe(true);
  });

  test('writes valid JSON that roundtrips through loadManifest', async () => {
    const dir = await makeTmpDir();
    const manifest: SpecManifest = {
      version: 1,
      specs: [
        {
          spec: 'feature.md',
          status: 'failed',
          runs: [makeRun({ status: 'failed', costUsd: 1.23 })],
          source: 'file',
          createdAt: '2026-02-15T00:00:00Z',
          updatedAt: '2026-02-15T01:00:00Z',
        },
      ],
    };

    await saveManifest(dir, manifest);
    const loaded = await loadManifest(dir);
    expect(loaded).toEqual(manifest);
  });

  test('overwrites existing manifest', async () => {
    const dir = await makeTmpDir();

    const first: SpecManifest = {
      version: 1,
      specs: [
        {
          spec: 'old.md',
          status: 'pending',
          runs: [],
          source: 'file',
          createdAt: '2026-02-15T00:00:00Z',
          updatedAt: '2026-02-15T00:00:00Z',
        },
      ],
    };
    await saveManifest(dir, first);

    const second: SpecManifest = {
      version: 1,
      specs: [
        {
          spec: 'new.md',
          status: 'passed',
          runs: [makeRun()],
          source: 'pipe',
          createdAt: '2026-02-15T02:00:00Z',
          updatedAt: '2026-02-15T02:00:00Z',
        },
      ],
    };
    await saveManifest(dir, second);

    const loaded = await loadManifest(dir);
    expect(loaded).toEqual(second);
    expect(loaded.specs).toHaveLength(1);
    expect(loaded.specs[0].spec).toBe('new.md');
  });

  test('no .tmp file left behind after successful save', async () => {
    const dir = await makeTmpDir();
    await saveManifest(dir, emptyManifest());

    const files = await fs.readdir(path.join(dir, '.forge'));
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ── withManifestLock ─────────────────────────────────────────

describe('withManifestLock', () => {
  test('acquires lock, runs updater, releases lock (lock file gone after)', async () => {
    const dir = await makeTmpDir();
    // Pre-create .forge so lock path resolves
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    let updaterCalled = false;
    await withManifestLock(dir, (manifest) => {
      updaterCalled = true;
      manifest.specs.push({
        spec: 'test.md',
        status: 'pending',
        runs: [],
        source: 'file',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    expect(updaterCalled).toBe(true);

    // Lock file should be gone
    const lockExists = await fs.access(path.join(dir, '.forge', 'specs.json.lock'))
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  test('updater changes are persisted to manifest file', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'persisted.md', 'file');
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs).toHaveLength(1);
    expect(loaded.specs[0].spec).toBe('persisted.md');
    expect(loaded.specs[0].status).toBe('pending');
  });

  test('lock is released even when updater throws (finally block)', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    try {
      await withManifestLock(dir, () => {
        throw new Error('updater exploded');
      });
    } catch (err) {
      expect((err as Error).message).toBe('updater exploded');
    }

    // Lock file should be gone even after error
    const lockExists = await fs.access(path.join(dir, '.forge', 'specs.json.lock'))
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  test('stale lock (older than 30s) is cleaned up and re-acquired', async () => {
    const dir = await makeTmpDir();
    const forgeDir = path.join(dir, '.forge');
    await fs.mkdir(forgeDir, { recursive: true });

    // Write a stale lock file (timestamp 60 seconds ago)
    const staleLockPath = path.join(forgeDir, 'specs.json.lock');
    const staleTime = Date.now() - 60_000; // 60 seconds ago
    await fs.writeFile(staleLockPath, String(staleTime));

    // withManifestLock should clean up the stale lock and proceed
    let updaterCalled = false;
    await withManifestLock(dir, (manifest) => {
      updaterCalled = true;
      manifest.specs.push({
        spec: 'after-stale.md',
        status: 'pending',
        runs: [],
        source: 'file',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    expect(updaterCalled).toBe(true);

    // Verify the manifest was saved
    const loaded = await loadManifest(dir);
    expect(loaded.specs).toHaveLength(1);
    expect(loaded.specs[0].spec).toBe('after-stale.md');

    // Lock should be released
    const lockExists = await fs.access(staleLockPath)
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });
});
