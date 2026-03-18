import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execAsync, createWorktree, cleanupWorktree } from './utils.js';
import { setupHermeticGit, teardownHermeticGit } from './test-utils.js';
import { getDb, listWorktrees, insertWorktree } from './db.js';
import { clearConfigCache } from './config.js';
import {
  calculateWorktreeDiskUsage,
  countActiveWorktrees,
  checkWorktreeLimits,
} from './worktree-limits.js';
import type { WorktreeRow } from './db.js';

// ── Hermetic Git ─────────────────────────────────────────────

beforeAll(() => { setupHermeticGit(); });
afterAll(() => { teardownHermeticGit(); });

// ── Test Helpers ─────────────────────────────────────────────

let tmpDir: string;

async function createTempGitRepo(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wt-limits-'));
  await execAsync('git init', { cwd: tmpDir });
  await execAsync('git config user.email "test@forge.dev"', { cwd: tmpDir });
  await execAsync('git config user.name "Forge Test"', { cwd: tmpDir });
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test Repo\n');
  await execAsync('git add -A && git commit -m "initial commit"', { cwd: tmpDir });
  return tmpDir;
}

async function cleanup(): Promise<void> {
  clearConfigCache();
  if (tmpDir) {
    try { await execAsync('git worktree prune', { cwd: tmpDir }); } catch {}
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/** Write a config file to the repo's .forge/config.json */
async function writeConfig(repoDir: string, config: Record<string, unknown>): Promise<void> {
  const forgeDir = path.join(repoDir, '.forge');
  await fs.mkdir(forgeDir, { recursive: true });
  await fs.writeFile(path.join(forgeDir, 'config.json'), JSON.stringify(config, null, 2));
  clearConfigCache();
}

/** Create a fake worktree row for testing. */
function fakeWorktreeRow(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  const id = `wt-${Date.now()}-${Math.random().toString(16).substring(2, 6)}`;
  return {
    id,
    work_group_id: null,
    spec_path: 'specs/test.md',
    spec_paths: '[]',
    branch: `forge/test-${id}`,
    worktree_path: '/tmp/nonexistent-worktree-path',
    status: 'complete',
    linear_issue_id: null,
    pid: null,
    task_id: null,
    session_id: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── countActiveWorktrees ─────────────────────────────────────

describe('countActiveWorktrees', () => {
  test('counts all non-cleaned worktrees', () => {
    const worktrees: WorktreeRow[] = [
      fakeWorktreeRow({ status: 'running' }),
      fakeWorktreeRow({ status: 'complete' }),
      fakeWorktreeRow({ status: 'merged' }),
      fakeWorktreeRow({ status: 'cleaned' }),
      fakeWorktreeRow({ status: 'failed' }),
    ];
    expect(countActiveWorktrees(worktrees)).toBe(4);
  });

  test('returns 0 for empty array', () => {
    expect(countActiveWorktrees([])).toBe(0);
  });

  test('returns 0 when all are cleaned', () => {
    const worktrees: WorktreeRow[] = [
      fakeWorktreeRow({ status: 'cleaned' }),
      fakeWorktreeRow({ status: 'cleaned' }),
    ];
    expect(countActiveWorktrees(worktrees)).toBe(0);
  });
});

// ── calculateWorktreeDiskUsage ───────────────────────────────

describe('calculateWorktreeDiskUsage', () => {
  test('returns 0 for empty array', async () => {
    expect(await calculateWorktreeDiskUsage([])).toBe(0);
  });

  test('returns 0 when all worktrees are cleaned', async () => {
    const worktrees = [fakeWorktreeRow({ status: 'cleaned' })];
    expect(await calculateWorktreeDiskUsage(worktrees)).toBe(0);
  });

  test('returns -1 when no directories can be measured', async () => {
    const worktrees = [
      fakeWorktreeRow({ status: 'complete', worktree_path: '/tmp/nonexistent-forge-wt-test-dir' }),
    ];
    expect(await calculateWorktreeDiskUsage(worktrees)).toBe(-1);
  });

  test('measures real directory size', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wt-disk-'));
    try {
      // Write some data
      await fs.writeFile(path.join(dir, 'data.txt'), 'x'.repeat(1024 * 100)); // ~100KB
      const worktrees = [fakeWorktreeRow({ status: 'complete', worktree_path: dir })];
      const usage = await calculateWorktreeDiskUsage(worktrees);
      expect(usage).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('sums multiple directories', async () => {
    const dir1 = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wt-disk1-'));
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wt-disk2-'));
    try {
      await fs.writeFile(path.join(dir1, 'data.txt'), 'x'.repeat(1024 * 50));
      await fs.writeFile(path.join(dir2, 'data.txt'), 'x'.repeat(1024 * 50));
      const worktrees = [
        fakeWorktreeRow({ status: 'complete', worktree_path: dir1 }),
        fakeWorktreeRow({ status: 'running', worktree_path: dir2 }),
      ];
      const usage = await calculateWorktreeDiskUsage(worktrees);
      expect(usage).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir1, { recursive: true, force: true });
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });

  test('skips cleaned worktrees', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wt-disk-'));
    try {
      await fs.writeFile(path.join(dir, 'data.txt'), 'x'.repeat(1024 * 100));
      const worktrees = [
        fakeWorktreeRow({ status: 'cleaned', worktree_path: dir }),
      ];
      // Cleaned worktree should be excluded -- returns 0
      expect(await calculateWorktreeDiskUsage(worktrees)).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── checkWorktreeLimits ──────────────────────────────────────

describe('checkWorktreeLimits', () => {
  beforeEach(async () => { await createTempGitRepo(); });
  afterEach(async () => {
    // Clean up sibling worktrees
    const parentDir = path.dirname(tmpDir);
    const projectName = path.basename(tmpDir);
    try {
      const entries = await fs.readdir(parentDir);
      for (const entry of entries) {
        if (entry.startsWith(`${projectName}-`) && entry !== path.basename(tmpDir)) {
          const p = path.join(parentDir, entry);
          try { await execAsync(`git worktree remove "${p}" --force`, { cwd: tmpDir }); } catch {}
          try { await fs.rm(p, { recursive: true, force: true }); } catch {}
        }
      }
    } catch {}
    try { await execAsync('git worktree prune', { cwd: tmpDir }); } catch {}
    await cleanup();
  });

  test('allows creation when under limits', async () => {
    await writeConfig(tmpDir, { maxWorktrees: 10, maxWorktreeDiskMb: 5000 });
    const result = await checkWorktreeLimits(tmpDir);
    expect(result.ok).toBe(true);
    expect(result.activeCount).toBe(0);
    expect(result.maxWorktrees).toBe(10);
  });

  test('blocks creation when count limit reached', async () => {
    // Set a very low limit
    await writeConfig(tmpDir, { maxWorktrees: 1, maxWorktreeDiskMb: 5000 });

    // Create a worktree (with force to bypass the very check we're testing)
    const wtPath = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/test.md',
      force: true,
    });

    try {
      const result = await checkWorktreeLimits(tmpDir);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Worktree limit reached');
      expect(result.error).toContain('1/1');
      expect(result.error).toContain('forge worktree prune');
      expect(result.activeCount).toBe(1);
    } finally {
      await cleanupWorktree(wtPath, tmpDir);
    }
  });

  test('blocks creation when disk limit reached', async () => {
    // Set a tiny disk limit (1 MB)
    await writeConfig(tmpDir, { maxWorktrees: 10, maxWorktreeDiskMb: 0.001 });

    // Create a worktree with force to bypass limits
    const wtPath = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/disk-test.md',
      force: true,
    });

    try {
      const result = await checkWorktreeLimits(tmpDir);
      // The worktree directory should exceed 0.001 MB
      // If disk check can measure it, it should fail
      if (result.diskUsageMb >= 0) {
        expect(result.ok).toBe(false);
        expect(result.error).toContain('disk limit reached');
        expect(result.error).toContain('forge worktree prune');
      }
    } finally {
      await cleanupWorktree(wtPath, tmpDir);
    }
  });

  test('createWorktree respects limits', async () => {
    await writeConfig(tmpDir, { maxWorktrees: 1, maxWorktreeDiskMb: 5000 });

    // First worktree -- should succeed
    const wtPath1 = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/first.md',
    });

    try {
      // Second worktree -- should fail due to limit
      await expect(
        createWorktree(tmpDir, 'ignored', {
          spec_path: 'specs/second.md',
        })
      ).rejects.toThrow('Worktree limit reached');
    } finally {
      await cleanupWorktree(wtPath1, tmpDir);
    }
  });

  test('createWorktree allows bypass with force', async () => {
    await writeConfig(tmpDir, { maxWorktrees: 1, maxWorktreeDiskMb: 5000 });

    const wtPath1 = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/first.md',
      force: true,
    });

    let wtPath2: string | undefined;
    try {
      // Second worktree with force -- should succeed despite limit
      wtPath2 = await createWorktree(tmpDir, 'ignored', {
        spec_path: 'specs/second.md',
        force: true,
      });
      expect(wtPath2).toBeTruthy();
    } finally {
      await cleanupWorktree(wtPath1, tmpDir);
      if (wtPath2) await cleanupWorktree(wtPath2, tmpDir);
    }
  });

  test('does not count cleaned worktrees toward limit', async () => {
    await writeConfig(tmpDir, { maxWorktrees: 1, maxWorktreeDiskMb: 5000 });

    // Create and clean up a worktree
    const wtPath = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/will-clean.md',
    });
    await cleanupWorktree(wtPath, tmpDir);

    // Mark the DB entry as cleaned if it exists
    const db = getDb(tmpDir);
    if (db) {
      const { getWorktreeByPath, updateWorktreeStatus } = await import('./db.js');
      const wtRow = getWorktreeByPath(db, wtPath);
      if (wtRow) {
        updateWorktreeStatus(db, wtRow.id, 'cleaned');
      }
    }

    // Should be able to create another worktree (cleaned ones don't count)
    const wtPath2 = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/after-clean.md',
    });
    expect(wtPath2).toBeTruthy();
    await cleanupWorktree(wtPath2, tmpDir);
  });

  test('includes merged worktrees in count', async () => {
    await writeConfig(tmpDir, { maxWorktrees: 1, maxWorktreeDiskMb: 5000 });

    // Create a worktree and mark it as merged
    const wtPath = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/merged.md',
      force: true,
    });

    const db = getDb(tmpDir);
    if (db) {
      const { getWorktreeByPath, updateWorktreeStatus } = await import('./db.js');
      const wtRow = getWorktreeByPath(db, wtPath);
      if (wtRow) {
        updateWorktreeStatus(db, wtRow.id, 'merged');
      }
    }

    try {
      // Merged worktree still counts toward limit (directory still on disk)
      const result = await checkWorktreeLimits(tmpDir);
      expect(result.ok).toBe(false);
      expect(result.activeCount).toBe(1);
    } finally {
      await cleanupWorktree(wtPath, tmpDir);
    }
  });

  test('returns ok when DB unavailable', async () => {
    // Create a directory without DB
    const noDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wt-nodb-'));
    try {
      const result = await checkWorktreeLimits(noDbDir);
      expect(result.ok).toBe(true);
    } finally {
      await fs.rm(noDbDir, { recursive: true, force: true });
    }
  });
});
