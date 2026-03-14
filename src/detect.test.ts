import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { detectPackageManager } from './utils.js';

// ── Test Helpers ─────────────────────────────────────────────

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'forge-detect-test-'));
}

async function writeFile(dir: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── detectPackageManager ────────────────────────────────────

describe('detectPackageManager', () => {
  test('returns bun when bun.lockb exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'bun.lockb', '');
    expect(await detectPackageManager(tmpDir)).toBe('bun');
  });

  test('returns bun when bun.lock exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'bun.lock', '');
    expect(await detectPackageManager(tmpDir)).toBe('bun');
  });

  test('returns pnpm when pnpm-lock.yaml exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'pnpm-lock.yaml', '');
    expect(await detectPackageManager(tmpDir)).toBe('pnpm');
  });

  test('returns yarn when yarn.lock exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'yarn.lock', '');
    expect(await detectPackageManager(tmpDir)).toBe('yarn');
  });

  test('returns npm when package-lock.json exists', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'package-lock.json', '{}');
    expect(await detectPackageManager(tmpDir)).toBe('npm');
  });

  test('returns npm as default when only package.json exists (no lockfile)', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    expect(await detectPackageManager(tmpDir)).toBe('npm');
  });

  test('returns null when no package.json exists', async () => {
    expect(await detectPackageManager(tmpDir)).toBeNull();
  });

  test('bun.lockb takes precedence over pnpm-lock.yaml', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'bun.lockb', '');
    await writeFile(tmpDir, 'pnpm-lock.yaml', '');
    expect(await detectPackageManager(tmpDir)).toBe('bun');
  });

  test('pnpm-lock.yaml takes precedence over yarn.lock', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'pnpm-lock.yaml', '');
    await writeFile(tmpDir, 'yarn.lock', '');
    expect(await detectPackageManager(tmpDir)).toBe('pnpm');
  });

  test('yarn.lock takes precedence over package-lock.json', async () => {
    await writeFile(tmpDir, 'package.json', '{}');
    await writeFile(tmpDir, 'yarn.lock', '');
    await writeFile(tmpDir, 'package-lock.json', '{}');
    expect(await detectPackageManager(tmpDir)).toBe('yarn');
  });

  test('returns null for Cargo.toml-only project', async () => {
    await writeFile(tmpDir, 'Cargo.toml', '[package]');
    expect(await detectPackageManager(tmpDir)).toBeNull();
  });

  test('returns null for Go-only project', async () => {
    await writeFile(tmpDir, 'go.mod', 'module example.com');
    expect(await detectPackageManager(tmpDir)).toBeNull();
  });
});
