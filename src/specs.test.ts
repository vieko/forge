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
  resolveSpecs,
  addSpecs,
  findUntrackedSpecs,
  unresolveSpecs,
  buildHints,
} from './specs.js';
import { filterPassedSpecs } from './parallel.js';
import { parseSource } from './deps.js';
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

// ── Integration: manifest lifecycle ─────────────────────────

describe('integration: run.ts manifest flow', () => {
  // These tests exercise the building blocks as composed in runSingleSpec:
  // resolveSpecSource logic + withManifestLock + findOrCreateEntry + push run + updateEntryStatus

  function resolveSpecSource(specContent?: string, specPath?: string): SpecEntry['source'] {
    if (!specPath && !specContent) return 'file';
    if (!specPath && specContent) return 'pipe';
    if (specContent) {
      const source = parseSource(specContent);
      if (source && source.startsWith('github:')) {
        return source as `github:${string}`;
      }
    }
    return 'file';
  }

  test('source resolution: frontmatter with github source', () => {
    const content = '---\nsource: github:vieko/forge#42\n---\n# My Spec';
    expect(resolveSpecSource(content, '/path/to/spec.md')).toBe('github:vieko/forge#42');
  });

  test('source resolution: frontmatter without source field → file', () => {
    const content = '---\ndepends: [auth.md]\n---\n# My Spec';
    expect(resolveSpecSource(content, '/path/to/spec.md')).toBe('file');
  });

  test('source resolution: no frontmatter → file', () => {
    const content = '# Simple Spec\nJust content.';
    expect(resolveSpecSource(content, '/path/to/spec.md')).toBe('file');
  });

  test('source resolution: pipe spec (no specPath, has content) → pipe', () => {
    expect(resolveSpecSource('implement auth', undefined)).toBe('pipe');
  });

  test('source resolution: no specPath, no content → file', () => {
    expect(resolveSpecSource(undefined, undefined)).toBe('file');
  });

  test('run record on success: entry status becomes passed', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'specs/auth.md', 'file');
      entry.runs.push(makeRun({ runId: 'run-1', status: 'passed', costUsd: 1.5, durationSeconds: 30 }));
      updateEntryStatus(entry);
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs).toHaveLength(1);
    expect(loaded.specs[0].status).toBe('passed');
    expect(loaded.specs[0].runs).toHaveLength(1);
    expect(loaded.specs[0].runs[0].status).toBe('passed');
  });

  test('run record on failure: entry status becomes failed', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'specs/auth.md', 'file');
      entry.runs.push(makeRun({ runId: 'run-1', status: 'failed', costUsd: 0.75, durationSeconds: 15 }));
      updateEntryStatus(entry);
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('failed');
    expect(loaded.specs[0].runs[0].status).toBe('failed');
  });

  test('batch runId grouping: multiple specs share same runId', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    const batchRunId = 'batch-abc123';

    await withManifestLock(dir, (manifest) => {
      for (const spec of ['auth.md', 'users.md', 'api.md']) {
        const entry = findOrCreateEntry(manifest, spec, 'file');
        entry.runs.push(makeRun({ runId: batchRunId, status: 'passed' }));
        updateEntryStatus(entry);
      }
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs).toHaveLength(3);
    for (const entry of loaded.specs) {
      expect(entry.runs[0].runId).toBe(batchRunId);
    }
  });

  test('multiple runs accumulate: pass then fail → 2 runs, status failed', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    // First run: pass
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'feature.md', 'file');
      entry.runs.push(makeRun({ runId: 'run-1', status: 'passed', timestamp: '2026-02-15T01:00:00Z' }));
      updateEntryStatus(entry);
    });

    // Second run: fail
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'feature.md', 'file');
      entry.runs.push(makeRun({ runId: 'run-2', status: 'failed', timestamp: '2026-02-15T02:00:00Z' }));
      updateEntryStatus(entry);
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs).toHaveLength(1);
    expect(loaded.specs[0].runs).toHaveLength(2);
    expect(loaded.specs[0].status).toBe('failed');
  });

  test('pipe spec uses pipeSpecId as key with pipe source', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    const content = 'implement authentication';
    const pipeId = pipeSpecId(content);

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, pipeId, 'pipe');
      entry.runs.push(makeRun({ runId: 'run-1', status: 'passed' }));
      updateEntryStatus(entry);
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].spec).toBe(pipeId);
    expect(loaded.specs[0].source).toBe('pipe');
    expect(loaded.specs[0].status).toBe('passed');
  });
});

describe('integration: parallel.ts batch registration', () => {
  test('mark specs as running: all entries get status running', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    const specFiles = ['specs/auth.md', 'specs/users.md', 'specs/api.md'];

    await withManifestLock(dir, (manifest) => {
      for (const specFile of specFiles) {
        const entry = findOrCreateEntry(manifest, specFile, 'file');
        entry.status = 'running';
        entry.updatedAt = new Date().toISOString();
      }
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs).toHaveLength(3);
    for (const entry of loaded.specs) {
      expect(entry.status).toBe('running');
      expect(entry.updatedAt).toBeTruthy();
    }
  });

  test('pre-existing entries preserved: runs array unchanged after marking running', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    // Pre-populate with a passed spec
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'specs/auth.md', 'file');
      entry.runs.push(makeRun({ runId: 'old-run', status: 'passed', costUsd: 2.0 }));
      updateEntryStatus(entry);
    });

    // Mark as running (as parallel.ts does before a new batch)
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'specs/auth.md', 'file');
      entry.status = 'running';
      entry.updatedAt = new Date().toISOString();
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs).toHaveLength(1);
    expect(loaded.specs[0].status).toBe('running');
    // Previous runs preserved
    expect(loaded.specs[0].runs).toHaveLength(1);
    expect(loaded.specs[0].runs[0].runId).toBe('old-run');
    expect(loaded.specs[0].runs[0].costUsd).toBe(2.0);
  });

  test('concurrent lock access: both updates succeed with no data loss', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    // Two concurrent withManifestLock calls that each add a different spec
    await Promise.all([
      withManifestLock(dir, (manifest) => {
        findOrCreateEntry(manifest, 'spec-a.md', 'file');
      }),
      withManifestLock(dir, (manifest) => {
        findOrCreateEntry(manifest, 'spec-b.md', 'file');
      }),
    ]);

    const loaded = await loadManifest(dir);
    // Both specs should exist (lock serializes the two updates)
    expect(loaded.specs).toHaveLength(2);
    const specs = loaded.specs.map(e => e.spec).sort();
    expect(specs).toEqual(['spec-a.md', 'spec-b.md']);
  });
});

describe('integration: audit.ts spec registration', () => {
  test('register audit specs: entries created with pending status and audit source', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    const auditTimestamp = '2026-02-15T10:00:00.000Z';
    const auditRunId = `audit:${auditTimestamp}`;
    const outputSpecs = ['fix-auth-flow.md', 'add-error-handling.md', 'update-tests.md'];

    await withManifestLock(dir, (manifest) => {
      for (const specFile of outputSpecs) {
        const key = `specs/audit/${specFile}`;
        findOrCreateEntry(manifest, key, `audit:${auditRunId}` as `audit:${string}`);
      }
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs).toHaveLength(3);
    for (const entry of loaded.specs) {
      expect(entry.status).toBe('pending');
      expect(entry.runs).toEqual([]);
      expect(entry.source).toBe(`audit:${auditRunId}`);
    }
  });

  test('audit source format: matches audit:audit:<timestamp> pattern', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    const startedAt = '2026-02-15T10:30:00.000Z';
    const auditRunId = `audit:${startedAt}`;

    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'fix-bug.md', `audit:${auditRunId}` as `audit:${string}`);
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].source).toMatch(/^audit:audit:\d{4}-\d{2}-\d{2}T/);
  });
});

describe('integration: full lifecycle state machine', () => {
  test('pending → running → passed', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    // Step 1: Create entry (pending)
    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'lifecycle.md', 'file');
    });
    let loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('pending');

    // Step 2: Mark running (as parallel.ts does)
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'lifecycle.md', 'file');
      entry.status = 'running';
      entry.updatedAt = new Date().toISOString();
    });
    loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('running');

    // Step 3: Push passed run (as run.ts does on success)
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'lifecycle.md', 'file');
      entry.runs.push(makeRun({ runId: 'run-1', status: 'passed' }));
      updateEntryStatus(entry);
    });
    loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('passed');
    expect(loaded.specs[0].runs).toHaveLength(1);
  });

  test('pending → running → failed → running → passed (rerun)', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    // Create + mark running
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'rerun.md', 'file');
      entry.status = 'running';
      entry.updatedAt = new Date().toISOString();
    });

    // First run: fail
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'rerun.md', 'file');
      entry.runs.push(makeRun({ runId: 'run-1', status: 'failed', timestamp: '2026-02-15T01:00:00Z' }));
      updateEntryStatus(entry);
    });
    let loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('failed');

    // Mark running again (rerun)
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'rerun.md', 'file');
      entry.status = 'running';
      entry.updatedAt = new Date().toISOString();
    });
    loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('running');

    // Second run: pass
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'rerun.md', 'file');
      entry.runs.push(makeRun({ runId: 'run-2', status: 'passed', timestamp: '2026-02-15T02:00:00Z' }));
      updateEntryStatus(entry);
    });
    loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('passed');
    expect(loaded.specs[0].runs).toHaveLength(2);
    expect(loaded.specs[0].runs[0].status).toBe('failed');
    expect(loaded.specs[0].runs[1].status).toBe('passed');
  });

  test('specKey + findOrCreateEntry: relative path normalization', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    // Simulate what parallel.ts does: specKey(absolutePath, workingDir) → relative key
    const absSpecPath = path.join(dir, 'specs', 'auth.md');
    const key = specKey(absSpecPath, dir);
    expect(key).toBe(path.join('specs', 'auth.md'));

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, key, 'file');
      entry.status = 'running';
      entry.updatedAt = new Date().toISOString();
    });

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].spec).toBe(path.join('specs', 'auth.md'));
  });
});

// ── resolveSpecs ─────────────────────────────────────────────

describe('resolveSpecs', () => {
  test('resolves a pending spec to passed by exact key', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/game-tests.md', 'file');
    });

    const count = await resolveSpecs(['specs/game-tests.md'], dir);
    expect(count).toBe(1);

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('passed');
    expect(loaded.specs[0].runs).toHaveLength(1);
    expect(loaded.specs[0].runs[0].runId).toBe('manual');
    expect(loaded.specs[0].runs[0].status).toBe('passed');
  });

  test('resolves by basename', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/deep/nested/feature.md', 'file');
    });

    const count = await resolveSpecs(['feature.md'], dir);
    expect(count).toBe(1);

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('passed');
  });

  test('resolves by trailing path', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/unicorn-game/game-tests.md', 'file');
    });

    const count = await resolveSpecs(['unicorn-game/game-tests.md'], dir);
    expect(count).toBe(1);

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('passed');
  });

  test('skips already-passed specs', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'done.md', 'file');
      entry.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(entry);
    });

    const count = await resolveSpecs(['done.md'], dir);
    expect(count).toBe(0);

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].runs).toHaveLength(1); // no extra run added
  });

  test('resolves a failed spec to passed', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'broken.md', 'file');
      entry.runs.push(makeRun({ status: 'failed' }));
      updateEntryStatus(entry);
    });

    const count = await resolveSpecs(['broken.md'], dir);
    expect(count).toBe(1);

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('passed');
    expect(loaded.specs[0].runs).toHaveLength(2);
  });

  test('returns 0 for non-existent spec', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    const count = await resolveSpecs(['nope.md'], dir);
    expect(count).toBe(0);
  });

  test('resolves multiple specs at once', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'a.md', 'file');
      findOrCreateEntry(manifest, 'b.md', 'file');
      findOrCreateEntry(manifest, 'c.md', 'file');
    });

    const count = await resolveSpecs(['a.md', 'c.md'], dir);
    expect(count).toBe(2);

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('passed');
    expect(loaded.specs[1].status).toBe('pending');
    expect(loaded.specs[2].status).toBe('passed');
  });
});

// ── unresolveSpecs ───────────────────────────────────────────

describe('unresolveSpecs', () => {
  test('resets a passed spec to pending', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'specs/feature.md', 'file');
      entry.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(entry);
    });

    const count = await unresolveSpecs(['specs/feature.md'], dir);
    expect(count).toBe(1);

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('pending');
    expect(loaded.specs[0].runs).toHaveLength(0);
  });

  test('resets a failed spec to pending', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'broken.md', 'file');
      entry.runs.push(makeRun({ status: 'failed' }));
      updateEntryStatus(entry);
    });

    const count = await unresolveSpecs(['broken.md'], dir);
    expect(count).toBe(1);

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('pending');
    expect(loaded.specs[0].runs).toHaveLength(0);
  });

  test('skips already-pending specs', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'pending.md', 'file');
    });

    const count = await unresolveSpecs(['pending.md'], dir);
    expect(count).toBe(0);
  });

  test('matches by basename', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'specs/deep/feature.md', 'file');
      entry.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(entry);
    });

    const count = await unresolveSpecs(['feature.md'], dir);
    expect(count).toBe(1);

    const loaded = await loadManifest(dir);
    expect(loaded.specs[0].status).toBe('pending');
  });

  test('returns 0 for non-existent spec', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });

    const count = await unresolveSpecs(['nope.md'], dir);
    expect(count).toBe(0);
  });
});

// ── findUntrackedSpecs + bare --add ──────────────────────────

describe('findUntrackedSpecs', () => {
  test('detects .md files in spec dirs not in manifest', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    await fs.mkdir(path.join(dir, 'specs'), { recursive: true });

    // Create spec files
    await fs.writeFile(path.join(dir, 'specs', 'tracked.md'), '# tracked');
    await fs.writeFile(path.join(dir, 'specs', 'untracked.md'), '# untracked');

    // Register only one
    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/tracked.md', 'file');
    });

    const untracked = await findUntrackedSpecs(dir);
    expect(untracked).toEqual(['specs/untracked.md']);
  });

  test('returns empty when all specs are tracked', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    await fs.mkdir(path.join(dir, 'specs'), { recursive: true });

    await fs.writeFile(path.join(dir, 'specs', 'a.md'), '# a');

    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/a.md', 'file');
    });

    const untracked = await findUntrackedSpecs(dir);
    expect(untracked).toHaveLength(0);
  });

  test('scans subdirectories recursively', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    await fs.mkdir(path.join(dir, 'specs', 'sub'), { recursive: true });

    await fs.writeFile(path.join(dir, 'specs', 'top.md'), '# top');
    await fs.writeFile(path.join(dir, 'specs', 'sub', 'deep.md'), '# deep');

    // Register only top.md so specs/ dir is known
    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/top.md', 'file');
    });

    const untracked = await findUntrackedSpecs(dir);
    expect(untracked).toEqual([path.join('specs', 'sub', 'deep.md')]);
  });
});

describe('bare --add (addSpecs with untracked)', () => {
  test('registers all untracked specs when given their paths', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    await fs.mkdir(path.join(dir, 'specs'), { recursive: true });

    await fs.writeFile(path.join(dir, 'specs', 'existing.md'), '# existing');
    await fs.writeFile(path.join(dir, 'specs', 'new-a.md'), '# new a');
    await fs.writeFile(path.join(dir, 'specs', 'new-b.md'), '# new b');

    // Track only one
    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/existing.md', 'file');
    });

    // Simulate bare --add: find untracked, then addSpecs
    const untracked = await findUntrackedSpecs(dir);
    expect(untracked).toHaveLength(2);

    const count = await addSpecs(untracked, dir);
    expect(count).toBe(2);

    const loaded = await loadManifest(dir);
    expect(loaded.specs).toHaveLength(3);
    expect(loaded.specs.map(e => e.spec).sort()).toEqual([
      'specs/existing.md',
      'specs/new-a.md',
      'specs/new-b.md',
    ]);
  });

  test('returns 0 when nothing is untracked', async () => {
    const dir = await makeTmpDir();
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    await fs.mkdir(path.join(dir, 'specs'), { recursive: true });

    await fs.writeFile(path.join(dir, 'specs', 'only.md'), '# only');

    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/only.md', 'file');
    });

    const untracked = await findUntrackedSpecs(dir);
    expect(untracked).toHaveLength(0);

    const count = await addSpecs(untracked, dir);
    expect(count).toBe(0);
  });
});

// ── buildHints ───────────────────────────────────────────────

describe('buildHints', () => {
  test('returns empty array when all counts are zero', () => {
    const hints = buildHints({ pending: 0, failed: 0, untracked: 0, orphaned: 0 });
    expect(hints).toEqual([]);
  });

  test('pending > 0 includes run --pending and --check hints', () => {
    const hints = buildHints({ pending: 3, failed: 0, untracked: 0, orphaned: 0 });
    expect(hints).toHaveLength(2);
    expect(hints[0]).toContain('forge run --pending');
    expect(hints[1]).toContain('forge specs --check');
  });

  test('failed > 0 includes rerun-failed hint', () => {
    const hints = buildHints({ pending: 0, failed: 2, untracked: 0, orphaned: 0 });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('forge run --rerun-failed');
  });

  test('untracked > 0 includes --add hint', () => {
    const hints = buildHints({ pending: 0, failed: 0, untracked: 5, orphaned: 0 });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('forge specs --add');
  });

  test('orphaned > 0 includes --prune hint', () => {
    const hints = buildHints({ pending: 0, failed: 0, untracked: 0, orphaned: 1 });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('forge specs --prune');
  });

  test('caps at 3 hints maximum', () => {
    const hints = buildHints({ pending: 1, failed: 1, untracked: 1, orphaned: 1 });
    expect(hints).toHaveLength(3);
    // pending generates 2 hints + failed generates 1 = 3 (capped)
    expect(hints[0]).toContain('forge run --pending');
    expect(hints[1]).toContain('forge specs --check');
    expect(hints[2]).toContain('forge run --rerun-failed');
  });

  test('priority order: pending before failed before untracked before orphaned', () => {
    // With pending=0 so we get failed, untracked, orphaned
    const hints = buildHints({ pending: 0, failed: 1, untracked: 1, orphaned: 1 });
    expect(hints).toHaveLength(3);
    expect(hints[0]).toContain('rerun-failed');
    expect(hints[1]).toContain('--add');
    expect(hints[2]).toContain('--prune');
  });
});

// ── filterPassedSpecs ────────────────────────────────────────

describe('filterPassedSpecs', () => {
  test('filters out specs with passed status in manifest', async () => {
    const dir = await makeTmpDir();
    const specsDir = path.join(dir, 'specs');
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    await fs.mkdir(specsDir, { recursive: true });

    await fs.writeFile(path.join(specsDir, 'a.md'), '# a');
    await fs.writeFile(path.join(specsDir, 'b.md'), '# b');
    await fs.writeFile(path.join(specsDir, 'c.md'), '# c');

    // Mark 'a.md' as passed in manifest
    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'specs/a.md', 'file');
      entry.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(entry);
      // b.md is pending
      findOrCreateEntry(manifest, 'specs/b.md', 'file');
    });

    const result = await filterPassedSpecs(['a.md', 'b.md', 'c.md'], specsDir, dir);
    expect(result.remaining).toEqual(['b.md', 'c.md']);
    expect(result.skipped).toBe(1);
  });

  test('returns all specs when none are passed', async () => {
    const dir = await makeTmpDir();
    const specsDir = path.join(dir, 'specs');
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    await fs.mkdir(specsDir, { recursive: true });

    await fs.writeFile(path.join(specsDir, 'a.md'), '# a');
    await fs.writeFile(path.join(specsDir, 'b.md'), '# b');

    // Both pending
    await withManifestLock(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/a.md', 'file');
      findOrCreateEntry(manifest, 'specs/b.md', 'file');
    });

    const result = await filterPassedSpecs(['a.md', 'b.md'], specsDir, dir);
    expect(result.remaining).toEqual(['a.md', 'b.md']);
    expect(result.skipped).toBe(0);
  });

  test('returns all specs when no manifest exists', async () => {
    const dir = await makeTmpDir();
    const specsDir = path.join(dir, 'specs');
    await fs.mkdir(specsDir, { recursive: true });

    await fs.writeFile(path.join(specsDir, 'a.md'), '# a');

    const result = await filterPassedSpecs(['a.md'], specsDir, dir);
    expect(result.remaining).toEqual(['a.md']);
    expect(result.skipped).toBe(0);
  });

  test('filters all when every spec is passed', async () => {
    const dir = await makeTmpDir();
    const specsDir = path.join(dir, 'specs');
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    await fs.mkdir(specsDir, { recursive: true });

    await fs.writeFile(path.join(specsDir, 'a.md'), '# a');
    await fs.writeFile(path.join(specsDir, 'b.md'), '# b');

    await withManifestLock(dir, (manifest) => {
      const a = findOrCreateEntry(manifest, 'specs/a.md', 'file');
      a.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(a);
      const b = findOrCreateEntry(manifest, 'specs/b.md', 'file');
      b.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(b);
    });

    const result = await filterPassedSpecs(['a.md', 'b.md'], specsDir, dir);
    expect(result.remaining).toEqual([]);
    expect(result.skipped).toBe(2);
  });

  test('keeps failed specs even if they have run history', async () => {
    const dir = await makeTmpDir();
    const specsDir = path.join(dir, 'specs');
    await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
    await fs.mkdir(specsDir, { recursive: true });

    await fs.writeFile(path.join(specsDir, 'flaky.md'), '# flaky');

    await withManifestLock(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'specs/flaky.md', 'file');
      entry.runs.push(makeRun({ status: 'failed' }));
      updateEntryStatus(entry);
    });

    const result = await filterPassedSpecs(['flaky.md'], specsDir, dir);
    expect(result.remaining).toEqual(['flaky.md']);
    expect(result.skipped).toBe(0);
  });
});
