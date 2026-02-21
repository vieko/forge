import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execAsync, createWorktree, commitWorktree, cleanupWorktree } from './utils.js';

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

// ── createWorktree ──────────────────────────────────────────

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

// ── commitWorktree ──────────────────────────────────────────

describe('commitWorktree', () => {
  let wtPath: string;

  beforeEach(async () => {
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
  beforeEach(async () => { await createTempGitRepo(); });
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
