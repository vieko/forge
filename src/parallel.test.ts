import { describe, test, expect, afterEach, mock, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import type { ForgeResult, SpecManifest } from './types.js';
import { ForgeError } from './utils.js';
import { getDb, insertRun, closeDb } from './db.js';
import type { RunRow } from './db.js';

// ── Mock boundary: runSingleSpec ─────────────────────────────
// bun hoists mock.module before static imports, so parallel.ts
// receives the mocked ./run.js when it loads.

const mockRunCalls: Array<{ specPath: string; label?: string }> = [];
let mockRunBehavior: 'success' | 'fail' | ((opts: any) => ForgeResult | Promise<ForgeResult>) = 'success';

mock.module('./run.js', () => ({
  runSingleSpec: async (opts: any): Promise<ForgeResult> => {
    mockRunCalls.push({ specPath: opts.specPath, label: opts._specLabel });

    if (typeof mockRunBehavior === 'function') {
      return mockRunBehavior(opts);
    }

    if (mockRunBehavior === 'fail') {
      const result: ForgeResult = {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationSeconds: 1,
        status: 'error_execution',
        costUsd: 0.25,
        prompt: opts.prompt || 'test',
        model: 'sonnet',
        cwd: opts.cwd || '/tmp',
      };
      throw new ForgeError('Mock verification failure', result);
    }

    return {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationSeconds: 1,
      status: 'success',
      costUsd: 0.50,
      prompt: opts.prompt || 'test',
      model: 'sonnet',
      cwd: opts.cwd || '/tmp',
    };
  },
}));

import {
  smartDispatch,
  filterPassedSpecs,
  findFailedSpecs,
  findPendingSpecs,
  runSpecBatch,
  printBatchSummary,
  runForge,
} from './parallel.js';

import {
  withSpecTransaction,
  findOrCreateEntry,
  updateEntryStatus,
  loadManifest,
  specKey,
} from './specs.js';

// ── Helpers ──────────────────────────────────────────────────

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-parallel-test-'));
  // Resolve symlinks (macOS /var -> /private/var) so realpath in
  // resolveWorkingDir returns the same path we use for specFilePaths.
  const dir = await fs.realpath(raw);
  tmpDirs.push(dir);
  return dir;
}

async function setupForge(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.forge'), { recursive: true });
}

async function writeSpec(dir: string, relPath: string, content = '# Spec'): Promise<string> {
  const full = path.join(dir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

function makeRun(overrides: any = {}) {
  return {
    runId: 'run-1',
    timestamp: '2026-02-15T00:00:00Z',
    resultPath: '.forge/results/2026-02-15T00:00:00Z',
    status: 'passed' as const,
    costUsd: 0.5,
    durationSeconds: 60,
    ...overrides,
  };
}

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: `run-${Math.random().toString(36).slice(2, 10)}`,
    specPath: null,
    model: 'sonnet',
    status: 'success',
    costUsd: 0.5,
    durationSeconds: 10,
    numTurns: 5,
    toolCalls: 3,
    batchId: null,
    type: 'run',
    prompt: 'test',
    cwd: '/tmp/test',
    sessionId: null,
    error: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function insertRunInDir(dir: string, overrides: Partial<RunRow> = {}): void {
  const db = getDb(dir);
  if (!db) throw new Error('Failed to open DB for test');
  insertRun(db, makeRunRow(overrides));
}

afterEach(async () => {
  for (const d of tmpDirs) {
    closeDb(d);
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs = [];
  mockRunCalls.length = 0;
  mockRunBehavior = 'success';
});

// ── smartDispatch ────────────────────────────────────────────

describe('smartDispatch', () => {
  test('returns specDir when prompt resolves to a directory with .md files', async () => {
    const dir = await makeTmpDir();
    await writeSpec(dir, 'specs/auth.md');
    await writeSpec(dir, 'specs/users.md');

    const result = await smartDispatch('specs', dir, dir);
    expect(result).not.toBeNull();
    expect(result!.specDir).toBe(path.join(dir, 'specs'));
    expect(result!.prompt).toBe('implement this specification');
    expect(result!.specPath).toBeUndefined();
  });

  test('returns specPath when prompt resolves to a single .md file', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/auth.md');

    // Register in manifest so resolveSpecFile can find it
    await withSpecTransaction(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/auth.md', 'file');
    });

    const result = await smartDispatch('auth.md', dir, dir);
    expect(result).not.toBeNull();
    expect(result!.specPath).toBe(path.join(dir, 'specs', 'auth.md'));
    expect(result!.specDir).toBeUndefined();
    expect(result!.prompt).toBe('implement this specification');
  });

  test('returns null when prompt does not resolve to any spec', async () => {
    const dir = await makeTmpDir();
    const result = await smartDispatch('implement the authentication module', dir, dir);
    expect(result).toBeNull();
  });

  test('returns null for prompt with spaces containing .md', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/auth.md');

    const result = await smartDispatch('fix auth.md formatting', dir, dir);
    expect(result).toBeNull();
  });

  test('directory without .md files does not return as specDir', async () => {
    const dir = await makeTmpDir();
    const specsDir = path.join(dir, 'specs');
    await fs.mkdir(specsDir, { recursive: true });
    await fs.writeFile(path.join(specsDir, 'readme.txt'), 'not a spec');

    const result = await smartDispatch('specs', dir, dir);
    // No .md files means it won't match as specDir;
    // may still resolve as specPath via file fallback
    expect(result?.specDir).toBeUndefined();
  });

  test('still matches directory containing only index.md (filtering is downstream)', async () => {
    const dir = await makeTmpDir();
    await writeSpec(dir, 'specs/index.md', '# Index');

    const result = await smartDispatch('specs', dir, dir);
    // smartDispatch checks for ANY .md file; skip-filtering is in runForgeInner
    expect(result).not.toBeNull();
    expect(result!.specDir).toBe(path.join(dir, 'specs'));
  });

  test('falls back to effectiveWorkingDir when resultDir has no match', async () => {
    const resultDir = await makeTmpDir();
    const workDir = await makeTmpDir();
    await writeSpec(workDir, 'specs/auth.md');

    const result = await smartDispatch('specs', resultDir, workDir);
    expect(result).not.toBeNull();
    expect(result!.specDir).toBe(path.join(workDir, 'specs'));
  });

  test('prefers resultDir over effectiveWorkingDir', async () => {
    const resultDir = await makeTmpDir();
    const workDir = await makeTmpDir();
    await writeSpec(resultDir, 'specs/auth.md');
    await writeSpec(workDir, 'specs/other.md');

    const result = await smartDispatch('specs', resultDir, workDir);
    expect(result).not.toBeNull();
    expect(result!.specDir).toBe(path.join(resultDir, 'specs'));
  });
});

describe('runForge outcome', () => {
  test('throws when a spec-dir batch has failing specs', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/a.md');
    await writeSpec(dir, 'specs/b.md');
    mockRunBehavior = 'fail';

    await expect(runForge({
      prompt: 'implement',
      specDir: path.join(dir, 'specs'),
      cwd: dir,
      quiet: true,
    })).rejects.toThrow('One or more specs failed');
  });
});

// ── filterPassedSpecs ────────────────────────────────────────

describe('filterPassedSpecs', () => {
  test('filters passed specs and keeps pending and failed', async () => {
    const dir = await makeTmpDir();
    const specsDir = path.join(dir, 'specs');
    await setupForge(dir);
    await writeSpec(dir, 'specs/passed.md');
    await writeSpec(dir, 'specs/pending.md');
    await writeSpec(dir, 'specs/failed.md');

    await withSpecTransaction(dir, (manifest) => {
      const p = findOrCreateEntry(manifest, 'specs/passed.md', 'file');
      p.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(p);

      findOrCreateEntry(manifest, 'specs/pending.md', 'file');

      const f = findOrCreateEntry(manifest, 'specs/failed.md', 'file');
      f.runs.push(makeRun({ status: 'failed' }));
      updateEntryStatus(f);
    });

    const result = await filterPassedSpecs(
      ['passed.md', 'pending.md', 'failed.md'],
      specsDir,
      dir,
    );
    expect(result.remaining).toEqual(['pending.md', 'failed.md']);
    expect(result.skipped).toBe(1);
    expect(result.skippedNames.has('passed.md')).toBe(true);
  });

  test('returns all specs with empty manifest', async () => {
    const dir = await makeTmpDir();
    const specsDir = path.join(dir, 'specs');
    await fs.mkdir(specsDir, { recursive: true });

    const result = await filterPassedSpecs(['a.md', 'b.md'], specsDir, dir);
    expect(result.remaining).toEqual(['a.md', 'b.md']);
    expect(result.skipped).toBe(0);
    expect(result.skippedNames.size).toBe(0);
  });

  test('skippedNames set matches all filtered spec names', async () => {
    const dir = await makeTmpDir();
    const specsDir = path.join(dir, 'specs');
    await setupForge(dir);
    await writeSpec(dir, 'specs/a.md');
    await writeSpec(dir, 'specs/b.md');
    await writeSpec(dir, 'specs/c.md');

    await withSpecTransaction(dir, (manifest) => {
      const a = findOrCreateEntry(manifest, 'specs/a.md', 'file');
      a.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(a);

      const c = findOrCreateEntry(manifest, 'specs/c.md', 'file');
      c.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(c);
    });

    const result = await filterPassedSpecs(['a.md', 'b.md', 'c.md'], specsDir, dir);
    expect(result.remaining).toEqual(['b.md']);
    expect(result.skipped).toBe(2);
    expect(result.skippedNames).toEqual(new Set(['a.md', 'c.md']));
  });
});

// ── findFailedSpecs ──────────────────────────────────────────

describe('findFailedSpecs', () => {
  test('returns failed spec paths from latest batch', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const batchId = 'batch-001';
    insertRunInDir(dir, {
      batchId,
      status: 'error_execution',
      specPath: path.join(dir, 'specs/auth.md'),
      createdAt: '2026-03-01T10:00:00Z',
    });
    insertRunInDir(dir, {
      batchId,
      status: 'success',
      specPath: path.join(dir, 'specs/users.md'),
      createdAt: '2026-03-01T10:01:00Z',
    });
    insertRunInDir(dir, {
      batchId,
      status: 'error_execution',
      specPath: path.join(dir, 'specs/api.md'),
      createdAt: '2026-03-01T10:02:00Z',
    });

    const result = await findFailedSpecs(dir);
    expect(result.runId).toBe(batchId);
    expect(result.specPaths).toHaveLength(2);
    expect(result.specPaths).toContain(path.join(dir, 'specs/auth.md'));
    expect(result.specPaths).toContain(path.join(dir, 'specs/api.md'));
  });

  test('returns empty specPaths when all specs in latest batch passed', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const batchId = 'batch-002';
    insertRunInDir(dir, {
      batchId,
      status: 'success',
      specPath: path.join(dir, 'specs/auth.md'),
      createdAt: '2026-03-01T11:00:00Z',
    });
    insertRunInDir(dir, {
      batchId,
      status: 'success',
      specPath: path.join(dir, 'specs/users.md'),
      createdAt: '2026-03-01T11:01:00Z',
    });

    const result = await findFailedSpecs(dir);
    expect(result.runId).toBe(batchId);
    expect(result.specPaths).toHaveLength(0);
  });

  test('throws when DB has no batch runs', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    // Ensure DB exists but has no runs
    const db = getDb(dir);
    expect(db).not.toBeNull();

    await expect(findFailedSpecs(dir)).rejects.toThrow('No batch runs found');
  });

  test('throws when only non-batch runs exist (no batchId)', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    // Run without a batchId (single-spec run, not a batch)
    insertRunInDir(dir, {
      batchId: null,
      status: 'success',
      createdAt: '2026-03-01T12:00:00Z',
    });

    await expect(findFailedSpecs(dir)).rejects.toThrow('No batch runs found');
  });

  test('only returns failures from the latest batch', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    // Older batch
    insertRunInDir(dir, {
      batchId: 'old-batch',
      status: 'error_execution',
      specPath: path.join(dir, 'specs/old-fail.md'),
      createdAt: '2026-03-01T08:00:00Z',
    });

    // Newer batch
    insertRunInDir(dir, {
      batchId: 'new-batch',
      status: 'error_execution',
      specPath: path.join(dir, 'specs/new-fail.md'),
      createdAt: '2026-03-01T10:00:00Z',
    });

    const result = await findFailedSpecs(dir);
    expect(result.runId).toBe('new-batch');
    expect(result.specPaths).toEqual([path.join(dir, 'specs/new-fail.md')]);
  });
});

// ── findPendingSpecs ─────────────────────────────────────────

describe('findPendingSpecs', () => {
  test('returns pending specs that exist on disk', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/pending-a.md');
    await writeSpec(dir, 'specs/pending-b.md');

    await withSpecTransaction(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/pending-a.md', 'file');
      findOrCreateEntry(manifest, 'specs/pending-b.md', 'file');
    });

    const result = await findPendingSpecs(dir);
    expect(result).toHaveLength(2);
    expect(result).toContain(path.join(dir, 'specs/pending-a.md'));
    expect(result).toContain(path.join(dir, 'specs/pending-b.md'));
  });

  test('includes running specs (treated as incomplete)', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/running.md');

    await withSpecTransaction(dir, (manifest) => {
      const entry = findOrCreateEntry(manifest, 'specs/running.md', 'file');
      entry.status = 'running';
    });

    const result = await findPendingSpecs(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(path.join(dir, 'specs/running.md'));
  });

  test('skips passed and failed specs', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/passed.md');
    await writeSpec(dir, 'specs/failed.md');
    await writeSpec(dir, 'specs/pending.md');

    await withSpecTransaction(dir, (manifest) => {
      const p = findOrCreateEntry(manifest, 'specs/passed.md', 'file');
      p.runs.push(makeRun({ status: 'passed' }));
      updateEntryStatus(p);

      const f = findOrCreateEntry(manifest, 'specs/failed.md', 'file');
      f.runs.push(makeRun({ status: 'failed' }));
      updateEntryStatus(f);

      findOrCreateEntry(manifest, 'specs/pending.md', 'file');
    });

    const result = await findPendingSpecs(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(path.join(dir, 'specs/pending.md'));
  });

  test('skips pipe specs', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    await withSpecTransaction(dir, (manifest) => {
      findOrCreateEntry(manifest, 'pipe:abc123', 'pipe');
    });

    const result = await findPendingSpecs(dir);
    expect(result).toHaveLength(0);
  });

  test('returns empty array when no pending specs exist', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    const result = await findPendingSpecs(dir);
    expect(result).toHaveLength(0);
  });

  test('skips specs where file no longer exists on disk', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    // Register a spec that was never created on disk
    await withSpecTransaction(dir, (manifest) => {
      findOrCreateEntry(manifest, 'specs/deleted.md', 'file');
    });

    const result = await findPendingSpecs(dir);
    expect(result).toHaveLength(0);
  });
});

// ── runSpecBatch ─────────────────────────────────────────────

describe('runSpecBatch', () => {
  test('sequential mode runs all specs and returns results', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/a.md', '# A');
    await writeSpec(dir, 'specs/b.md', '# B');
    await writeSpec(dir, 'specs/c.md', '# C');

    const specPaths = ['a.md', 'b.md', 'c.md'].map(f => path.join(dir, 'specs', f));
    const specNames = ['a.md', 'b.md', 'c.md'];

    const { results, hasTracker } = await runSpecBatch(
      specPaths,
      specNames,
      { prompt: 'test', sequential: true, quiet: true, cwd: dir },
      1,
      'test-run-1',
    );

    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'success')).toBe(true);
    expect(mockRunCalls).toHaveLength(3);

    // Manifest should have entries for all 3 specs
    const manifest = await loadManifest(dir);
    expect(manifest.specs).toHaveLength(3);
  });

  test('sequential mode preserves spec order', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/first.md', '# First');
    await writeSpec(dir, 'specs/second.md', '# Second');
    await writeSpec(dir, 'specs/third.md', '# Third');

    const specPaths = ['first.md', 'second.md', 'third.md'].map(f =>
      path.join(dir, 'specs', f),
    );

    await runSpecBatch(
      specPaths,
      ['first.md', 'second.md', 'third.md'],
      { prompt: 'test', sequential: true, quiet: true, cwd: dir },
      1,
      'test-run-order',
    );

    expect(mockRunCalls.map(c => path.basename(c.specPath))).toEqual([
      'first.md',
      'second.md',
      'third.md',
    ]);
  });

  test('dep-graph mode resolves levels and executes in topological order', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    // a.md: no deps (level 1)
    await writeSpec(dir, 'specs/a.md', '# A\nNo deps');
    // b.md: depends on a.md (level 2)
    await writeSpec(dir, 'specs/b.md', '---\ndepends: [a.md]\n---\n# B');
    // c.md: depends on b.md (level 3)
    await writeSpec(dir, 'specs/c.md', '---\ndepends: [b.md]\n---\n# C');

    const specPaths = ['a.md', 'b.md', 'c.md'].map(f => path.join(dir, 'specs', f));

    const { results } = await runSpecBatch(
      specPaths,
      ['a.md', 'b.md', 'c.md'],
      { prompt: 'test', sequential: false, quiet: true, cwd: dir },
      2,
      'test-run-deps',
    );

    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'success')).toBe(true);

    // Each level has 1 spec, so they run sequentially via tracker.
    // Topological order: a -> b -> c
    expect(mockRunCalls.map(c => path.basename(c.specPath))).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ]);
  });

  test('handles spec failures gracefully in sequential mode', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/ok.md', '# OK');
    await writeSpec(dir, 'specs/fail.md', '# Fail');
    await writeSpec(dir, 'specs/after.md', '# After');

    let callCount = 0;
    mockRunBehavior = () => {
      callCount++;
      if (callCount === 2) {
        throw new ForgeError('Mock failure', {
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationSeconds: 1,
          status: 'error_execution',
          costUsd: 0.25,
          prompt: 'test',
          model: 'sonnet',
          cwd: '/tmp',
        });
      }
      return {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationSeconds: 1,
        status: 'success' as const,
        costUsd: 0.50,
        prompt: 'test',
        model: 'sonnet',
        cwd: '/tmp',
      };
    };

    const specPaths = ['ok.md', 'fail.md', 'after.md'].map(f =>
      path.join(dir, 'specs', f),
    );

    const { results } = await runSpecBatch(
      specPaths,
      ['ok.md', 'fail.md', 'after.md'],
      { prompt: 'test', sequential: true, quiet: true, cwd: dir },
      1,
      'test-run-fail',
    );

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('success');
    expect(results[1].status).toContain('failed');
    expect(results[2].status).toBe('success');
    // All 3 specs attempted -- sequential continues on failure
    expect(mockRunCalls).toHaveLength(3);
  });

  test('satisfied deps are stripped from dependency graph', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    // b.md depends on a.md, but a.md is satisfied (not in batch)
    await writeSpec(dir, 'specs/b.md', '---\ndepends: [a.md]\n---\n# B');
    await writeSpec(dir, 'specs/c.md', '# C');

    const specPaths = ['b.md', 'c.md'].map(f => path.join(dir, 'specs', f));

    const { results } = await runSpecBatch(
      specPaths,
      ['b.md', 'c.md'],
      { prompt: 'test', sequential: false, quiet: true, cwd: dir },
      2,
      'test-run-satisfied',
      new Set(['a.md']),
    );

    // Both should run (a.md dep stripped as already satisfied)
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === 'success')).toBe(true);
  });

  test('registers all specs as running in manifest before execution', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/x.md', '# X');
    await writeSpec(dir, 'specs/y.md', '# Y');

    // Custom mock that snapshots manifest during execution
    let manifestDuringRun: SpecManifest | null = null;
    mockRunBehavior = async () => {
      if (!manifestDuringRun) {
        manifestDuringRun = await loadManifest(dir);
      }
      return {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationSeconds: 1,
        status: 'success' as const,
        costUsd: 0.50,
        prompt: 'test',
        model: 'sonnet',
        cwd: dir,
      };
    };

    const specPaths = ['x.md', 'y.md'].map(f => path.join(dir, 'specs', f));

    await runSpecBatch(
      specPaths,
      ['x.md', 'y.md'],
      { prompt: 'test', sequential: true, quiet: true, cwd: dir },
      1,
      'test-run-manifest',
    );

    // During first spec execution, both should already be 'running'
    expect(manifestDuringRun).not.toBeNull();
    expect(manifestDuringRun!.specs).toHaveLength(2);
    for (const entry of manifestDuringRun!.specs) {
      expect(entry.status).toBe('running');
    }
  });

  test('throws on circular dependencies in dep-graph mode', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);

    await writeSpec(dir, 'specs/a.md', '---\ndepends: [b.md]\n---\n# A');
    await writeSpec(dir, 'specs/b.md', '---\ndepends: [a.md]\n---\n# B');

    const specPaths = ['a.md', 'b.md'].map(f => path.join(dir, 'specs', f));

    await expect(
      runSpecBatch(
        specPaths,
        ['a.md', 'b.md'],
        { prompt: 'test', sequential: false, quiet: true, cwd: dir },
        2,
        'test-run-cycle',
      ),
    ).rejects.toThrow('Circular dependency');
  });

  test('sequential-first splits correctly between phases', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/a.md', '# A');
    await writeSpec(dir, 'specs/b.md', '# B');
    await writeSpec(dir, 'specs/c.md', '# C');

    const specPaths = ['a.md', 'b.md', 'c.md'].map(f => path.join(dir, 'specs', f));

    const { results } = await runSpecBatch(
      specPaths,
      ['a.md', 'b.md', 'c.md'],
      {
        prompt: 'test',
        sequential: false,
        sequentialFirst: 1,
        quiet: true,
        cwd: dir,
      },
      2,
      'test-run-seqfirst',
    );

    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'success')).toBe(true);
    expect(mockRunCalls).toHaveLength(3);
    // First spec is always first (sequential phase)
    expect(path.basename(mockRunCalls[0].specPath)).toBe('a.md');
  });

  test('batch results include cost and duration', async () => {
    const dir = await makeTmpDir();
    await setupForge(dir);
    await writeSpec(dir, 'specs/a.md', '# A');

    const specPaths = [path.join(dir, 'specs', 'a.md')];

    const { results } = await runSpecBatch(
      specPaths,
      ['a.md'],
      { prompt: 'test', sequential: true, quiet: true, cwd: dir },
      1,
      'test-run-cost',
    );

    expect(results).toHaveLength(1);
    expect(results[0].spec).toBe('a.md');
    expect(results[0].cost).toBe(0.50);
    expect(typeof results[0].duration).toBe('number');
    expect(results[0].duration).toBeGreaterThanOrEqual(0);
  });
});

// ── printBatchSummary ────────────────────────────────────────

describe('printBatchSummary', () => {
  test('all-pass with specDir shows audit hint', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });

    const results = [
      { spec: 'auth.md', status: 'success', cost: 0.5, duration: 10 },
      { spec: 'users.md', status: 'success', cost: 0.3, duration: 8 },
    ];

    printBatchSummary(results, 12, false, false, 'specs/');

    const output = logs.join('\n');
    expect(output).toContain('forge audit');
    expect(output).toContain('specs/');
    expect(output).toContain('2/2 successful');

    spy.mockRestore();
  });

  test('partial failure shows rerun-failed hint', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });

    const results = [
      { spec: 'auth.md', status: 'success', cost: 0.5, duration: 10 },
      { spec: 'users.md', status: 'failed: timeout', cost: 0.3, duration: 8 },
    ];

    printBatchSummary(results, 12, false, false);

    const output = logs.join('\n');
    expect(output).toContain('forge run --rerun-failed');
    expect(output).toContain('1/2 successful');

    spy.mockRestore();
  });

  test('quiet non-parallel mode suppresses all output', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });

    const results = [
      { spec: 'auth.md', status: 'success', cost: 0.5, duration: 10 },
    ];

    printBatchSummary(results, 10, false, true);
    expect(logs).toHaveLength(0);

    spy.mockRestore();
  });

  test('parallel mode shows wall-clock and spec total durations', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });

    const results = [
      { spec: 'a.md', status: 'success', cost: 0.5, duration: 20 },
      { spec: 'b.md', status: 'success', cost: 0.5, duration: 25 },
    ];

    printBatchSummary(results, 15, true, false, 'specs/');

    const output = logs.join('\n');
    expect(output).toContain('Wall-clock:');
    expect(output).toContain('Spec total:');
    expect(output).toContain('15.0s');
    expect(output).toContain('45.0s');

    spy.mockRestore();
  });

  test('hasTracker skips per-spec listing but keeps aggregates', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });

    const results = [
      { spec: 'auth.md', status: 'success', cost: 0.5, duration: 10 },
    ];

    printBatchSummary(results, 10, false, false, undefined, true);

    const output = logs.join('\n');
    // Tracker already showed per-spec results, so no "SPEC BATCH SUMMARY" header
    expect(output).not.toContain('SPEC BATCH SUMMARY');
    // Aggregates still shown
    expect(output).toContain('Wall-clock:');
    expect(output).toContain('1/1 successful');

    spy.mockRestore();
  });

  test('total cost is summed across all specs', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logs.push(args.join(' '));
    });

    const results = [
      { spec: 'a.md', status: 'success', cost: 1.25, duration: 10 },
      { spec: 'b.md', status: 'success', cost: 0.75, duration: 8 },
      { spec: 'c.md', status: 'success', cost: 2.00, duration: 12 },
    ];

    printBatchSummary(results, 30, false, false, 'specs/');

    const output = logs.join('\n');
    expect(output).toContain('$4.00');

    spy.mockRestore();
  });
});
