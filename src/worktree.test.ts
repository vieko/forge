import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execAsync, createWorktree, commitWorktree, cleanupWorktree, deriveSpecName } from './utils.js';
import { setupHermeticGit, teardownHermeticGit } from './test-utils.js';

// ── Hermetic Git ─────────────────────────────────────────────

beforeAll(() => { setupHermeticGit(); });
afterAll(() => { teardownHermeticGit(); });

// ── Test Helpers ─────────────────────────────────────────────

let tmpDir: string;

async function createTempGitRepo(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wt-test-'));
  await execAsync('git init', { cwd: tmpDir });
  await execAsync('git config user.email "test@forge.dev"', { cwd: tmpDir });
  await execAsync('git config user.name "Forge Test"', { cwd: tmpDir });
  // Need at least one commit for worktree operations
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test Repo\n');
  await execAsync('git add -A && git commit -m "initial commit"', { cwd: tmpDir });
  return tmpDir;
}

async function cleanup(): Promise<void> {
  if (tmpDir) {
    // Prune any leftover worktrees first
    try { await execAsync('git worktree prune', { cwd: tmpDir }); } catch {}
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── deriveSpecName ──────────────────────────────────────────

describe('deriveSpecName', () => {
  test('strips .md extension and lowercases', () => {
    expect(deriveSpecName('auth-login.md')).toBe('auth-login');
  });

  test('replaces non-alphanumeric with hyphens', () => {
    expect(deriveSpecName('My Feature!.md')).toBe('my-feature');
  });

  test('collapses consecutive hyphens', () => {
    expect(deriveSpecName('a--b---c.md')).toBe('a-b-c');
  });

  test('trims leading/trailing hyphens', () => {
    expect(deriveSpecName('-leading-trailing-.md')).toBe('leading-trailing');
  });

  test('handles path with directory prefix', () => {
    expect(deriveSpecName('specs/auth/login.md')).toBe('login');
  });

  test('handles names with dots', () => {
    expect(deriveSpecName('my.feature.spec.md')).toBe('my-feature-spec');
  });
});

// ── createWorktree (legacy mode) ────────────────────────────

describe('createWorktree', () => {
  beforeEach(async () => { await createTempGitRepo(); });
  afterEach(async () => {
    // Clean up any worktrees we created
    const safeBranch = 'test-branch'.replace(/[^a-zA-Z0-9_-]/g, '-');
    const worktreePath = path.join(os.tmpdir(), `forge-worktree-${safeBranch}`);
    try { await fs.rm(worktreePath, { recursive: true, force: true }); } catch {}
    try { await execAsync('git worktree prune', { cwd: tmpDir }); } catch {}
    await cleanup();
  });

  test('creates worktree with new branch from HEAD', async () => {
    const wtPath = await createWorktree(tmpDir, 'test-branch');
    expect(wtPath).toContain('forge-worktree-test-branch');

    // Verify directory exists
    const stat = await fs.stat(wtPath);
    expect(stat.isDirectory()).toBe(true);

    // Verify branch was created
    const { stdout } = await execAsync('git branch', { cwd: tmpDir });
    expect(stdout).toContain('test-branch');

    // Verify the worktree has the repo content
    const readme = await fs.readFile(path.join(wtPath, 'README.md'), 'utf-8');
    expect(readme).toBe('# Test Repo\n');

    // Cleanup
    await cleanupWorktree(wtPath, tmpDir);
  });

  test('checks out existing branch', async () => {
    // Create branch first
    await execAsync('git branch feature-existing', { cwd: tmpDir });

    const wtPath = await createWorktree(tmpDir, 'feature-existing');
    expect(wtPath).toContain('forge-worktree-feature-existing');

    const stat = await fs.stat(wtPath);
    expect(stat.isDirectory()).toBe(true);

    // Cleanup
    const safeBranch = 'feature-existing'.replace(/[^a-zA-Z0-9_-]/g, '-');
    const worktreePath = path.join(os.tmpdir(), `forge-worktree-${safeBranch}`);
    await cleanupWorktree(worktreePath, tmpDir);
  });

  test('errors when directory is not a git repo', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-wt-nogit-'));
    try {
      await expect(createWorktree(nonGitDir, 'test')).rejects.toThrow('--branch requires a git repository');
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });

  test('uses deterministic path based on branch name', async () => {
    const wtPath = await createWorktree(tmpDir, 'my-feature');
    const expected = path.join(os.tmpdir(), 'forge-worktree-my-feature');
    expect(wtPath).toBe(expected);
    await cleanupWorktree(wtPath, tmpDir);
  });

  test('sanitizes special characters in branch name for path', async () => {
    const wtPath = await createWorktree(tmpDir, 'feat/special-chars');
    expect(wtPath).toContain('forge-worktree-feat-special-chars');
    await cleanupWorktree(wtPath, tmpDir);
  });
});

// ── createWorktree (sibling mode) ───────────────────────────

describe('createWorktree sibling mode', () => {
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

  test('creates sibling directory with spec name', async () => {
    const wtPath = await createWorktree(tmpDir, 'ignored-branch', {
      spec_path: 'specs/auth-login.md',
    });

    // git rev-parse --show-toplevel resolves symlinks, so use realpath for comparison
    const realTmpDir = await fs.realpath(tmpDir);
    const parentDir = path.dirname(realTmpDir);
    const projectName = path.basename(realTmpDir);

    // Should be a sibling directory
    expect(path.dirname(wtPath)).toBe(parentDir);
    // Should contain project name and spec name
    expect(path.basename(wtPath)).toBe(`${projectName}-auth-login`);

    // Verify directory exists
    const stat = await fs.stat(wtPath);
    expect(stat.isDirectory()).toBe(true);

    // Verify branch naming: forge/auth-login
    const { stdout } = await execAsync('git branch', { cwd: tmpDir });
    expect(stdout).toContain('forge/auth-login');

    // Verify repo content
    const readme = await fs.readFile(path.join(wtPath, 'README.md'), 'utf-8');
    expect(readme).toBe('# Test Repo\n');

    await cleanupWorktree(wtPath, tmpDir);
  });

  test('includes linear issue ID in directory and branch name', async () => {
    const wtPath = await createWorktree(tmpDir, 'ignored-branch', {
      spec_path: 'specs/auth-login.md',
      linear_issue_id: 'ENG-123',
    });

    const realTmpDir = await fs.realpath(tmpDir);
    const projectName = path.basename(realTmpDir);

    // Directory: {project}-ENG-123-auth-login
    expect(path.basename(wtPath)).toBe(`${projectName}-ENG-123-auth-login`);

    // Branch: forge/ENG-123/auth-login
    const { stdout } = await execAsync('git branch', { cwd: tmpDir });
    expect(stdout).toContain('forge/ENG-123/auth-login');

    await cleanupWorktree(wtPath, tmpDir);
  });

  test('runs workspace setup automatically for spec-driven worktrees', async () => {
    const forgeDir = path.join(tmpDir, '.forge');
    await fs.mkdir(forgeDir, { recursive: true });
    await fs.writeFile(
      path.join(forgeDir, 'config.json'),
      JSON.stringify({
        setup: ['sh -c "echo bootstrapped > .setup-ran"'],
      }),
    );

    const wtPath = await createWorktree(tmpDir, 'ignored-branch', {
      spec_path: 'specs/setup-check.md',
    });

    const marker = await fs.readFile(path.join(wtPath, '.setup-ran'), 'utf-8');
    expect(marker.trim()).toBe('bootstrapped');

    await cleanupWorktree(wtPath, tmpDir);
  });

  test('handles directory collision with numeric suffix', async () => {
    // Create first worktree
    const wtPath1 = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/collision.md',
    });

    // Create the directory that would collide (simulate pre-existing sibling)
    // The first worktree took the base name, so we need a new spec_path
    // that would produce the same base name to trigger collision.
    // Instead, manually create the colliding path and test second creation.
    const realTmpDir = await fs.realpath(tmpDir);
    const parentDir = path.dirname(realTmpDir);
    const projectName = path.basename(realTmpDir);

    // Clean up first worktree so the directory is free, then manually create blocking dir
    await cleanupWorktree(wtPath1, tmpDir);

    // Create blocking directory at the expected path
    const blockingPath = path.join(parentDir, `${projectName}-collision`);
    await fs.mkdir(blockingPath, { recursive: true });

    try {
      const wtPath2 = await createWorktree(tmpDir, 'ignored', {
        spec_path: 'specs/collision.md',
      });

      // Should have -2 suffix
      expect(path.basename(wtPath2)).toBe(`${projectName}-collision-2`);

      await cleanupWorktree(wtPath2, tmpDir);
    } finally {
      await fs.rm(blockingPath, { recursive: true, force: true });
    }
  });

  test('handles branch collision by appending suffix', async () => {
    // Create first worktree with forge/branch-test branch
    const wtPath1 = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/branch-test.md',
      work_group_id: 'wg-123-abcd',
    });

    // Now try to create another worktree with the same spec name
    // This should detect the branch is already checked out and suffix it
    const wtPath2 = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/branch-test.md',
      work_group_id: 'wg-456-ef01',
    });

    // The second worktree should have a different path (directory collision handled)
    expect(wtPath2).not.toBe(wtPath1);

    // Both should exist
    const stat1 = await fs.stat(wtPath1);
    const stat2 = await fs.stat(wtPath2);
    expect(stat1.isDirectory()).toBe(true);
    expect(stat2.isDirectory()).toBe(true);

    // The second branch should have the suffix from work_group_id (last 4 chars)
    const { stdout } = await execAsync('git branch', { cwd: tmpDir });
    expect(stdout).toContain('forge/branch-test');
    expect(stdout).toContain('forge/branch-test-ef01');

    await cleanupWorktree(wtPath1, tmpDir);
    await cleanupWorktree(wtPath2, tmpDir);
  });

  test('passes work_group_id to registry', async () => {
    const wtPath = await createWorktree(tmpDir, 'ignored', {
      spec_path: 'specs/wg-test.md',
      work_group_id: 'wg-1710500000-a3f2',
    });

    // Verify worktree was created
    const stat = await fs.stat(wtPath);
    expect(stat.isDirectory()).toBe(true);

    await cleanupWorktree(wtPath, tmpDir);
  });
});

// ── commitWorktree ──────────────────────────────────────────

describe('commitWorktree', () => {
  let wtPath: string;

  beforeEach(async () => {
    // Pre-clean stale worktree directory from previous failed runs
    const stalePath = path.join(os.tmpdir(), 'forge-worktree-commit-test');
    try { await fs.rm(stalePath, { recursive: true, force: true }); } catch {}
    await createTempGitRepo();
    wtPath = await createWorktree(tmpDir, 'commit-test');
  });

  afterEach(async () => {
    try { await cleanupWorktree(wtPath, tmpDir); } catch {}
    await cleanup();
  });

  test('commits all changes and returns true', async () => {
    // Make changes in the worktree
    await fs.writeFile(path.join(wtPath, 'new-file.ts'), 'export const x = 1;\n');

    const committed = await commitWorktree(wtPath, 'commit-test');
    expect(committed).toBe(true);

    // Verify commit exists
    const { stdout } = await execAsync('git log --oneline -1', { cwd: wtPath });
    expect(stdout).toContain('forge: branch isolation results on commit-test');
  });

  test('returns false when there are no changes', async () => {
    const committed = await commitWorktree(wtPath, 'commit-test');
    expect(committed).toBe(false);
  });

  test('stages untracked files', async () => {
    await fs.writeFile(path.join(wtPath, 'untracked.txt'), 'hello\n');
    await fs.mkdir(path.join(wtPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(wtPath, 'src', 'index.ts'), 'console.log("hello");\n');

    const committed = await commitWorktree(wtPath, 'commit-test');
    expect(committed).toBe(true);

    // Verify all files are committed
    const { stdout } = await execAsync('git show --name-only --format=""', { cwd: wtPath });
    expect(stdout).toContain('untracked.txt');
    expect(stdout).toContain('src/index.ts');
  });

  test('excludes .forge/ directory from commit', async () => {
    await fs.writeFile(path.join(wtPath, 'real-change.ts'), 'export const y = 2;\n');
    await fs.writeFile(path.join(wtPath, '.gitignore'), '.forge/\n');
    await fs.mkdir(path.join(wtPath, '.forge'), { recursive: true });
    await fs.writeFile(path.join(wtPath, '.forge', 'audit.jsonl'), '{"tool":"bash"}\n');
    await fs.writeFile(path.join(wtPath, '.forge', 'latest-session.json'), '{"id":"test"}\n');

    const committed = await commitWorktree(wtPath, 'commit-test');
    expect(committed).toBe(true);

    const { stdout } = await execAsync('git show --name-only --format=""', { cwd: wtPath });
    expect(stdout).toContain('real-change.ts');
    expect(stdout).not.toContain('.forge');
  });
});

// ── cleanupWorktree ─────────────────────────────────────────

describe('cleanupWorktree', () => {
  beforeEach(async () => {
    // Pre-clean stale worktree directories from previous failed runs
    for (const name of ['cleanup-test', 'prune-test']) {
      const stalePath = path.join(os.tmpdir(), `forge-worktree-${name}`);
      try { await fs.rm(stalePath, { recursive: true, force: true }); } catch {}
    }
    await createTempGitRepo();
  });
  afterEach(async () => { await cleanup(); });

  test('removes worktree directory', async () => {
    const wtPath = await createWorktree(tmpDir, 'cleanup-test');
    expect((await fs.stat(wtPath)).isDirectory()).toBe(true);

    await cleanupWorktree(wtPath, tmpDir);

    // Directory should no longer exist
    await expect(fs.stat(wtPath)).rejects.toThrow();
  });

  test('prunes worktree from git tracking', async () => {
    const wtPath = await createWorktree(tmpDir, 'prune-test');
    await cleanupWorktree(wtPath, tmpDir);

    // Verify no worktrees are listed
    const { stdout } = await execAsync('git worktree list --porcelain', { cwd: tmpDir });
    expect(stdout).not.toContain('prune-test');
  });

  test('does not throw if worktree already removed', async () => {
    const wtPath = path.join(os.tmpdir(), 'forge-worktree-nonexistent');
    // Should not throw
    await cleanupWorktree(wtPath, tmpDir);
  });
});
